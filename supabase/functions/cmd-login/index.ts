// cmd-login — Comodatos: entra com o USUARIO E SENHA DO SANKHYA (igual ao Sistema Coletor).
// 1) Valida no Sankhya (MobileLoginSP.login) e encerra a sessao do Sankhya logo em seguida.
// 2) Liga o NOMUSU a um usuario do Supabase (tabela cmd_usuarios) e devolve uma sessao dele,
//    para a tela continuar lendo as tabelas com RLS.
// A senha NUNCA e gravada: so passa por aqui para ser conferida no Sankhya.
// Recebe: { usuario, senha }   Devolve: { access_token, refresh_token, nomusu } ou { error }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SANKHYA_INSTANCE_HOST = Deno.env.get('SANKHYA_INSTANCE_HOST') || 'https://pannemixmassas.sankhyacloud.com.br'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const novoCliente = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function senhaConfereNoSankhya(usuario: string, senha: string): Promise<boolean> {
  const url = `${SANKHYA_INSTANCE_HOST}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceName: 'MobileLoginSP.login',
      requestBody: { NOMUSU: { $: usuario }, INTERNO: { $: senha }, KEEPCONNECTED: { $: 'N' } },
    }),
  })
  const d = await r.json().catch(() => null)
  const jsessionid = d?.responseBody?.jsessionid?.$
  if (String(d?.status) !== '1' || !jsessionid) return false

  // Encerra a sessao aberta so para conferir a senha (nao fica ocupando licenca do Sankhya).
  try {
    await fetch(`${SANKHYA_INSTANCE_HOST}/mge/service.sbr?serviceName=MobileLoginSP.logout&outputType=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `JSESSIONID=${jsessionid}` },
      body: JSON.stringify({ serviceName: 'MobileLoginSP.logout', requestBody: {} }),
    })
  } catch { /* se o logout falhar, a sessao expira sozinha no Sankhya */ }
  return true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return J({ error: 'metodo nao permitido' }, 405)

  try {
    const { usuario, senha } = await req.json().catch(() => ({}))
    const nomusu = String(usuario || '').trim().toUpperCase()
    if (!nomusu || !senha) return J({ error: 'Informe usuário e senha do Sankhya.' }, 400)

    if (!(await senhaConfereNoSankhya(nomusu, String(senha)))) {
      return J({ error: 'Usuário ou senha do Sankhya inválidos.' }, 401)
    }

    const admin = novoCliente()
    const { data: existente, error: eBusca } = await admin.from('cmd_usuarios')
      .select('user_id, ativo').eq('nomusu', nomusu).maybeSingle()
    if (eBusca) throw new Error('cmd_usuarios: ' + eBusca.message)
    if (existente && !existente.ativo) return J({ error: 'Seu usuário está bloqueado no sistema de comodatos.' }, 403)

    // E-mail interno do usuario sombra (nunca recebe mensagem; so identifica a conta no Supabase).
    const email = `${nomusu.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}@comodatos.sankhya.pannemix.com.br`
    if (!existente) {
      const { error } = await admin.auth.admin.createUser({
        email, email_confirm: true,
        app_metadata: { sistema: 'comodatos', nomusu },
        user_metadata: { nome: nomusu },
      })
      if (error && !/already|registered|exists/i.test(error.message)) throw new Error('criar usuario: ' + error.message)
    }

    // Gera e consome na hora um link de acesso: vira a sessao devolvida para a tela.
    const { data: link, error: eLink } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
    if (eLink || !link?.properties?.hashed_token) throw new Error('gerar acesso: ' + (eLink?.message || 'sem token'))
    const { data: s, error: eSessao } = await novoCliente().auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
    if (eSessao || !s?.session) throw new Error('abrir sessao: ' + (eSessao?.message || 'sem sessao'))

    const { error: eGrava } = await admin.from('cmd_usuarios').upsert(
      { nomusu, user_id: s.session.user.id, ultimo_login: new Date().toISOString() }, { onConflict: 'nomusu' })
    if (eGrava) throw new Error('cmd_usuarios: ' + eGrava.message)

    return J({ access_token: s.session.access_token, refresh_token: s.session.refresh_token, nomusu })
  } catch (e) {
    return J({ error: 'Erro no login: ' + (e as Error).message }, 500)
  }
})
