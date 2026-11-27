// cmd-sync-sankhya — Comodatos: SOMENTE LEITURA no Sankhya.
// Le as notas de remessa (TOP 1156) e retorno (1256, 1271, 1997) e grava em cmd_notas / cmd_notas_itens.
// Chamada pelo pg_cron a cada 5 min (header x-cron-key = cmd_segredos.cron_secret)
// ou por usuario logado pelo Sankhya (cmd_usuarios ativo) pelo botao "Atualizar agora".
// Body opcional: { "completo": true } relê todo o historico; padrao = ultimos 15 dias.
// Secrets necessarios na Edge Function: SANKHYA_CLIENT_ID, SANKHYA_CLIENT_SECRET, SANKHYA_XTOKEN (opcional SANKHYA_HOST).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SANKHYA_HOST = Deno.env.get('SANKHYA_HOST') || 'https://api.sankhya.com.br'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
}
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

// Devolve quem chamou: 'cron', 'usuario' (logado pelo Sankhya e ativo em cmd_usuarios) ou null.
async function autorizado(req: Request): Promise<'cron' | 'usuario' | null> {
  const chave = req.headers.get('x-cron-key')
  if (chave) {
    const { data } = await admin.from('cmd_segredos').select('valor').eq('chave', 'cron_secret').single()
    return !!data && data.valor === chave ? 'cron' : null
  }
  const auth = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!auth) return null
  const { data, error } = await admin.auth.getUser(auth)
  if (error || !data?.user) return null
  const { data: u } = await admin.from('cmd_usuarios').select('ativo').eq('user_id', data.user.id).maybeSingle()
  return u?.ativo ? 'usuario' : null
}

async function sankhyaAuth(): Promise<string> {
  const body = new URLSearchParams({
    client_id: Deno.env.get('SANKHYA_CLIENT_ID')!,
    client_secret: Deno.env.get('SANKHYA_CLIENT_SECRET')!,
    grant_type: 'client_credentials',
  })
  const r = await fetch(`${SANKHYA_HOST}/authenticate`, {
    method: 'POST',
    headers: { 'X-Token': Deno.env.get('SANKHYA_XTOKEN')!, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`autenticacao Sankhya ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const d = await r.json()
  const t = d.access_token || d.bearerToken || d.token
  if (!t) throw new Error('Sankhya sem access_token')
  return t
}

async function consulta(bearer: string, sql: string): Promise<Record<string, any>[]> {
  const r = await fetch(`${SANKHYA_HOST}/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceName: 'DbExplorerSP.executeQuery', requestBody: { sql } }),
  })
  const txt = await r.text()
  let d: any
  try { d = JSON.parse(txt) } catch { throw new Error(`resposta nao-JSON do Sankhya (${r.status}): ${txt.slice(0, 300)}`) }
  if (String(d?.status) !== '1') throw new Error(`consulta Sankhya: ${d?.statusMessage || txt.slice(0, 300)}`)
  const meta: string[] = d.responseBody?.fieldsMetadata?.map((f: any) => f.name) || []
  return (d.responseBody?.rows || []).map((row: any[]) => Object.fromEntries(meta.map((n, i) => [n, row[i]])))
}

// Sankhya devolve datas como "DDMMYYYY HH:MM:SS"
const data = (s: string | null) => (s ? `${s.slice(4, 8)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null)

function lotes<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const quem = await autorizado(req)
  if (!quem) return J({ error: 'nao autorizado' }, 401)

  const body = (await req.json().catch(() => null)) || {}
  // Pela tela so roda a leitura curta; a releitura completa (que apaga notas sumidas) e so do cron.
  if (quem === 'usuario') { body.completo = false; body.dias = Math.min(Number(body.dias) || 15, 30) }
  const { data: log } = await admin.from('cmd_sync_log').insert({}).select('id').single()

  try {
    const { data: cfg } = await admin.from('cmd_config').select('chave, valor')
    const c = Object.fromEntries((cfg || []).map((x: any) => [x.chave, x.valor]))
    const remessa = String(c.tops_remessa || '1156').split(',').map((x) => Number(x.trim())).filter(Boolean)
    const retorno = String(c.tops_retorno || '1256,1271,1997').split(',').map((x) => Number(x.trim())).filter(Boolean)
    const codparcPannemix = Number(c.codparc_pannemix || 1)
    const tops = [...remessa, ...retorno]
    const filtroData = body?.completo ? '' : ` AND C.DTNEG >= TRUNC(SYSDATE) - ${Number(body?.dias) || 15}`

    const bearer = await sankhyaAuth()

    const cab = await consulta(bearer,
      `SELECT C.NUNOTA, C.NUMNOTA, C.CODTIPOPER, C.DTNEG, C.CODPARC, C.STATUSNOTA, SUBSTR(C.OBSERVACAO,1,1000) OBS,
              P.NOMEPARC, P.CGC_CPF
         FROM TGFCAB C JOIN TGFPAR P ON P.CODPARC = C.CODPARC
        WHERE C.CODTIPOPER IN (${tops.join(',')})${filtroData}`)

    const nunotas = cab.map((r) => Number(r.NUNOTA))
    const itens: Record<string, any>[] = []
    for (const l of lotes(nunotas, 500)) {
      itens.push(...(await consulta(bearer,
        `SELECT I.NUNOTA, I.SEQUENCIA, I.CODPROD, I.QTDNEG, I.VLRUNIT, P.DESCRPROD
           FROM TGFITE I JOIN TGFPRO P ON P.CODPROD = I.CODPROD
          WHERE I.NUNOTA IN (${l.join(',')})`)))
    }

    // Clientes: cria/atualiza pelo CODPARC (exceto a propria Pannemix).
    const parceiros = new Map<number, any>()
    for (const r of cab) if (Number(r.CODPARC) !== codparcPannemix) parceiros.set(Number(r.CODPARC), r)
    for (const l of lotes([...parceiros.values()], 500)) {
      const { error } = await admin.from('cmd_clientes').upsert(
        l.map((r) => ({ codparc: Number(r.CODPARC), nome: r.NOMEPARC, cnpj_cpf: r.CGC_CPF, atualizado_em: new Date().toISOString() })),
        { onConflict: 'codparc' })
      if (error) throw new Error('cmd_clientes: ' + error.message)
    }
    const { data: clientes } = await admin.from('cmd_clientes').select('id, codparc').not('codparc', 'is', null)
    const idPorCodparc = new Map((clientes || []).map((x: any) => [Number(x.codparc), x.id]))

    // Produtos
    const prods = new Map<number, string>()
    for (const i of itens) prods.set(Number(i.CODPROD), i.DESCRPROD)
    for (const l of lotes([...prods.entries()], 500)) {
      const { error } = await admin.from('cmd_produtos').upsert(
        l.map(([codprod, descricao]) => ({ codprod, descricao, atualizado_em: new Date().toISOString() })),
        { onConflict: 'codprod' })
      if (error) throw new Error('cmd_produtos: ' + error.message)
    }

    // Notas: nao sobrescreve vinculo manual ja feito na tela.
    const { data: manuais } = await admin.from('cmd_notas').select('nunota, cliente_id').eq('vinculo_manual', true)
    const manual = new Map((manuais || []).map((x: any) => [Number(x.nunota), x.cliente_id]))
    const notas = cab.map((r) => {
      const nunota = Number(r.NUNOTA)
      const codparc = Number(r.CODPARC)
      const auto = codparc === codparcPannemix ? null : idPorCodparc.get(codparc) ?? null
      return {
        nunota,
        numnota: r.NUMNOTA != null ? Number(r.NUMNOTA) : null,
        codtipoper: Number(r.CODTIPOPER),
        tipo: remessa.includes(Number(r.CODTIPOPER)) ? 'REMESSA' : 'RETORNO',
        dtneg: data(r.DTNEG),
        codparc,
        statusnota: r.STATUSNOTA,
        observacao: r.OBS,
        cliente_id: manual.has(nunota) ? manual.get(nunota) : auto,
        vinculo_manual: manual.has(nunota),
        sincronizado_em: new Date().toISOString(),
      }
    })
    for (const l of lotes(notas, 500)) {
      const { error } = await admin.from('cmd_notas').upsert(l, { onConflict: 'nunota' })
      if (error) throw new Error('cmd_notas: ' + error.message)
    }

    // Itens: substitui os itens das notas lidas (a nota pode ter sido alterada no Sankhya).
    for (const l of lotes(nunotas, 500)) {
      const { error } = await admin.from('cmd_notas_itens').delete().in('nunota', l)
      if (error) throw new Error('cmd_notas_itens delete: ' + error.message)
    }
    const linhasItens = itens.map((i) => ({
      nunota: Number(i.NUNOTA), sequencia: Number(i.SEQUENCIA), codprod: Number(i.CODPROD),
      qtd: Number(i.QTDNEG), vlrunit: i.VLRUNIT != null ? Number(i.VLRUNIT) : null,
    }))
    for (const l of lotes(linhasItens, 1000)) {
      const { error } = await admin.from('cmd_notas_itens').insert(l)
      if (error) throw new Error('cmd_notas_itens: ' + error.message)
    }

    // Notas excluidas no Sankhya dentro da janela lida.
    let removidas = 0
    if (body?.completo) {
      const { data: locais } = await admin.from('cmd_notas').select('nunota')
      const existentes = new Set(nunotas)
      const apagar = (locais || []).map((x: any) => Number(x.nunota)).filter((n) => !existentes.has(n))
      for (const l of lotes(apagar, 500)) await admin.from('cmd_notas').delete().in('nunota', l)
      removidas = apagar.length
    }

    await admin.from('cmd_sync_log').update({
      finalizado_em: new Date().toISOString(), ok: true,
      notas_lidas: cab.length, notas_gravadas: notas.length, notas_removidas: removidas,
    }).eq('id', log?.id)

    return J({ ok: true, notas: notas.length, itens: linhasItens.length, removidas })
  } catch (e) {
    await admin.from('cmd_sync_log').update({ finalizado_em: new Date().toISOString(), ok: false, erro: String(e) }).eq('id', log?.id)
    return J({ ok: false, error: String(e) }, 500)
  }
})
