// Comodatos Pannemix — tela de saldo de equipamentos em comodato.
// Dados vem do Supabase (tabelas/views cmd_*), alimentadas pela funcao cmd-sync-sankhya.
const sb = window.supabase.createClient(window.CMD_CONFIG.supabaseUrl, window.CMD_CONFIG.supabaseKey)

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
const moeda = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataBR = (d) => (d ? d.split('-').reverse().join('/') : '—')

let saldo = []         // linhas de cmd_v_saldo
let clientes = []      // saldo agrupado por cliente
let notas = []         // cmd_notas com itens
let todosClientes = [] // cmd_clientes (para vincular retornos)
let clienteSel = null

function aviso(msg, ms = 4000) {
  const el = $('aviso')
  el.textContent = msg
  el.classList.remove('oculto')
  clearTimeout(aviso.t)
  aviso.t = setTimeout(() => el.classList.add('oculto'), ms)
}

// O Supabase devolve no maximo 1000 linhas por consulta: busca em paginas.
async function buscarTudo(montarConsulta) {
  const pagina = 1000
  let de = 0
  const tudo = []
  for (;;) {
    const { data, error } = await montarConsulta().range(de, de + pagina - 1)
    if (error) throw error
    tudo.push(...data)
    if (data.length < pagina) return tudo
    de += pagina
  }
}

// ---------------- LOGIN ----------------
async function iniciar() {
  const { data } = await sb.auth.getSession()
  // Sessao antiga (login por e-mail de outro sistema) nao vale aqui: so a aberta pelo Sankhya.
  if (data.session && data.session.user?.app_metadata?.sistema !== 'comodatos') await sb.auth.signOut()
  else if (data.session) return entrarNoApp()
  $('tela-login').classList.remove('oculto')
}

// Login com usuario e senha do Sankhya: a funcao cmd-login confere no Sankhya e devolve a sessao.
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const erro = $('login-erro')
  const botao = e.target.querySelector('button[type="submit"]')
  erro.textContent = ''
  botao.disabled = true
  botao.textContent = 'Conferindo no Sankhya...'
  try {
    const { data, error } = await sb.functions.invoke('cmd-login', {
      body: { usuario: $('login-usuario').value.trim(), senha: $('login-senha').value },
    })
    let msg = data?.error
    if (error && !msg) msg = (await error.context?.json?.().catch(() => null))?.error
    if (error || !data?.access_token) throw new Error(msg || 'Não foi possível entrar.')
    const { error: eSessao } = await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token })
    if (eSessao) throw eSessao
    $('login-senha').value = ''
    entrarNoApp()
  } catch (err) {
    erro.textContent = err.message || String(err)
  } finally {
    botao.disabled = false
    botao.textContent = 'Entrar'
  }
})

$('btn-sair').addEventListener('click', async () => { await sb.auth.signOut(); location.reload() })

async function entrarNoApp() {
  const { data } = await sb.auth.getUser()
  $('usuario-logado').textContent = data?.user?.app_metadata?.nomusu || ''
  $('tela-login').classList.add('oculto')
  $('tela-app').classList.remove('oculto')
  await carregarTudo()
  setInterval(atualizarStatusSync, 60000)
}

async function carregarTudo() {
  try {
    await Promise.all([carregarSaldo(), carregarNotas(), carregarClientes(), carregarConfig(), carregarSemSankhya()])
    await carregarPendentes()
    atualizarStatusSync()
  } catch (e) {
    aviso('Erro ao carregar: ' + (e.message || e), 8000)
  }
}

// ---------------- MENU LATERAL ----------------
document.querySelectorAll('.menu button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.menu button').forEach((x) => x.classList.toggle('ativa', x === b))
  document.querySelectorAll('.aba').forEach((a) => a.classList.add('oculto'))
  $('aba-' + b.dataset.aba).classList.remove('oculto')
  $('titulo-pagina').textContent = b.dataset.titulo
  $('sub-pagina').textContent = b.dataset.sub
}))

// ---------------- SINCRONIZACAO ----------------
async function atualizarStatusSync() {
  const { data } = await sb.from('cmd_sync_log').select('*').not('finalizado_em', 'is', null).order('id', { ascending: false }).limit(1)
  const u = data?.[0]
  const el = $('status-sync')
  if (!u) { el.textContent = 'Sankhya: ainda não sincronizado'; return }
  const quando = new Date(u.finalizado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  el.classList.toggle('falha', !u.ok)
  el.textContent = u.ok ? `Sankhya atualizado ${quando}` : `Falha na sincronização ${quando}`
  el.title = u.erro || ''
}

$('btn-sync').addEventListener('click', async () => {
  const b = $('btn-sync')
  const rotulo = b.querySelector('span')
  b.disabled = true
  rotulo.textContent = 'Atualizando...'
  try {
    const { data, error } = await sb.functions.invoke('cmd-sync-sankhya', { body: { dias: 15 } })
    if (error || !data?.ok) throw new Error(data?.error || error?.message || 'falha')
    aviso(`Sankhya sincronizado: ${data.notas} notas lidas.`)
    await carregarTudo()
  } catch (e) {
    aviso('Erro ao sincronizar: ' + e.message, 8000)
  } finally {
    b.disabled = false
    rotulo.textContent = 'Atualizar agora'
  }
})


// ---------------- SALDO ----------------
async function carregarSaldo() {
  saldo = await buscarTudo(() => sb.from('cmd_v_saldo').select('*').order('cliente').order('codprod'))
  const porCliente = new Map()
  for (const l of saldo) {
    if (!porCliente.has(l.cliente_id)) porCliente.set(l.cliente_id, { id: l.cliente_id, nome: l.cliente, codparc: l.codparc, itens: [] })
    porCliente.get(l.cliente_id).itens.push(l)
  }
  clientes = [...porCliente.values()]

  const produtos = new Map(saldo.map((l) => [l.codprod, l.produto]))
  const sel = $('filtro-produto')
  const atual = sel.value
  sel.innerHTML = '<option value="">Todos os equipamentos</option>' +
    [...produtos.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([c, d]) => `<option value="${c}">${esc(d)}</option>`).join('')
  sel.value = atual

  const positivos = saldo.filter((l) => Number(l.saldo) > 0)
  const totalQtd = positivos.reduce((s, l) => s + Number(l.saldo), 0)
  const totalValor = positivos.reduce((s, l) => s + Number(l.saldo) * Number(l.vlr_unit_ref || 0), 0)
  const comEquip = new Set(positivos.map((l) => l.cliente_id)).size
  const negativos = saldo.filter((l) => Number(l.saldo) < 0).length
  const ic = {
    loja: '<path d="M3 9l1-5h16l1 5M4 9v11h16V9M9 20v-6h6v6"/>',
    caixa: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
    moeda: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    alerta: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  }
  const kpi = (cor, icone, rotulo, valor, extra = '') =>
    `<div class="kpi ${cor} ${extra}"><div class="kpi-icone"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icone}</svg></div>
     <div><span>${rotulo}</span><b>${valor}</b></div></div>`
  $('resumo').innerHTML =
    kpi('terracota', ic.loja, 'Clientes com equipamento', num(comEquip)) +
    kpi('ouro', ic.caixa, 'Equipamentos nas lojas', num(totalQtd)) +
    kpi('creme', ic.moeda, 'Valor em comodato', moeda(totalValor)) +
    kpi('alerta', ic.alerta, 'Saldos a conferir', num(negativos), negativos ? 'ativo' : '')

  desenharGraficoProdutos(positivos)
  desenharClientes()
}

// Barras horizontais: quantidade nas lojas por tipo de equipamento.
function desenharGraficoProdutos(positivos) {
  const porProd = new Map()
  for (const l of positivos) porProd.set(l.produto, (porProd.get(l.produto) || 0) + Number(l.saldo))
  const top = [...porProd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const max = top[0]?.[1] || 1
  $('graf-produtos').innerHTML = top.length ? top.map(([p, q]) => `
    <div class="barra-linha" title="${esc(p)}"><span class="rot">${esc(p)}</span>
      <div class="trilho"><div class="cheio" style="width:${(q / max) * 100}%"></div></div><span class="val">${num(q)}</span></div>`).join('')
    : '<p class="sutil">Sem dados.</p>'
}

// Colunas: itens enviados x devolvidos por mes (ultimos 12 meses).
function desenharGraficoMeses() {
  const meses = []
  const hoje = new Date()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
    meses.push({ chave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rot: d.toLocaleString('pt-BR', { month: 'short' }).replace('.', ''), env: 0, dev: 0 })
  }
  const idx = new Map(meses.map((m, i) => [m.chave, i]))
  for (const n of notas) {
    if (n.statusnota !== 'L') continue
    const i = idx.get((n.dtneg || '').slice(0, 7))
    if (i === undefined) continue
    const q = (n.cmd_notas_itens || []).reduce((s, it) => s + Number(it.qtd), 0)
    if (n.tipo === 'REMESSA') meses[i].env += q
    else meses[i].dev += q
  }
  const max = Math.max(1, ...meses.map((m) => Math.max(m.env, m.dev)))
  $('graf-meses').innerHTML = meses.map((m) => `
    <div class="coluna" title="${m.rot}: ${m.env} enviados, ${m.dev} devolvidos">
      <i class="env" style="height:${(m.env / max) * 100}%"></i><i class="dev" style="height:${(m.dev / max) * 100}%"></i></div>`).join('')
  $('graf-meses-rotulos').innerHTML = meses.map((m) => `<span>${m.rot}</span>`).join('')
}

function clientesFiltrados() {
  const termo = $('busca-cliente').value.trim().toUpperCase()
  const prod = $('filtro-produto').value
  const soComSaldo = $('so-com-saldo').checked
  return clientes.map((c) => {
    const itens = prod ? c.itens.filter((i) => String(i.codprod) === prod) : c.itens
    return { ...c, itensFiltro: itens, total: itens.reduce((s, i) => s + Number(i.saldo), 0) }
  }).filter((c) => {
    if (prod && !c.itensFiltro.length) return false
    if (soComSaldo && !c.itensFiltro.some((i) => Number(i.saldo) !== 0)) return false
    if (!termo) return true
    return c.nome.toUpperCase().includes(termo) || String(c.codparc ?? '').includes(termo)
  })
}

// Nome curto do equipamento para caber nos "chips" da tabela.
const curto = (p) => String(p || '').replace(/\s*-\s*COMPLETA.*$/i, '').replace(/\s+/g, ' ').slice(0, 28)

function desenharClientes() {
  const lista = clientesFiltrados()
  $('contador-clientes').textContent = `${num(lista.length)} clientes`
  $('tabela-clientes').innerHTML = `
    <thead><tr><th>Cliente</th><th>Cód. Sankhya</th><th>Equipamentos na loja</th><th class="n">Qtd.</th><th class="n">Valor</th><th>Última mov.</th></tr></thead>
    <tbody>${lista.length ? lista.map((c) => {
      const itens = c.itensFiltro.filter((i) => Number(i.saldo) !== 0)
      const valor = itens.reduce((s, i) => s + Math.max(0, Number(i.saldo)) * Number(i.vlr_unit_ref || 0), 0)
      const ult = itens.map((i) => i.ultima_movimentacao).filter(Boolean).sort().pop()
      return `<tr data-id="${c.id}">
        <td><span class="cli-nome">${esc(c.nome)}</span>${/INATIV/i.test(c.nome) ? '<span class="inativo">INATIVO</span>' : ''}</td>
        <td class="cli-cod">${c.codparc ?? '—'}</td>
        <td><div class="chips">${itens.map((i) => `<span class="chip ${Number(i.saldo) < 0 ? 'neg' : ''}" title="${esc(i.produto)}">${num(i.saldo)}× ${esc(curto(i.produto))}</span>`).join('')}</div></td>
        <td class="n"><span class="total-pill">${num(c.total)}</span></td>
        <td class="n">${moeda(valor)}</td>
        <td class="cli-cod">${dataBR(ult)}</td></tr>`
    }).join('') : '<tr><td colspan="6" class="sutil">Nenhum cliente encontrado.</td></tr>'}</tbody>`
  document.querySelectorAll('#tabela-clientes tbody tr[data-id]').forEach((el) => el.addEventListener('click', () => abrirCliente(Number(el.dataset.id))))
}

function fecharGaveta() {
  $('gaveta').classList.remove('aberta')
  $('fundo-detalhe').classList.add('oculto')
}
$('fechar-gaveta').addEventListener('click', fecharGaveta)
$('fundo-detalhe').addEventListener('click', fecharGaveta)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharGaveta() })

;['busca-cliente', 'filtro-produto', 'so-com-saldo'].forEach((id) => $(id).addEventListener('input', desenharClientes))

async function abrirCliente(id) {
  clienteSel = id
  const c = clientes.find((x) => x.id === id)
  const det = $('detalhe-cliente')
  $('fundo-detalhe').classList.remove('oculto')
  $('gaveta').classList.add('aberta')
  det.innerHTML = '<p class="sutil">Carregando...</p>'
  const { data: movs, error } = await sb.from('cmd_v_movimentos').select('*').eq('cliente_id', id).order('data', { ascending: false })
  if (error) { det.innerHTML = `<p class="erro">${esc(error.message)}</p>`; return }
  const prodNome = new Map(saldo.map((l) => [l.codprod, l.produto]))
  const nomeOrigem = { PLANILHA: 'Planilha', REMESSA: 'Remessa', RETORNO: 'Retorno' }
  det.innerHTML = `
    <h2>${esc(c.nome)}</h2>
    <p class="sutil">${c.codparc ? 'Código Sankhya (CODPARC): ' + c.codparc : 'Sem código Sankhya'}</p>
    <h3>O que o cliente tem hoje</h3>
    <table>
      <tr><th>Cód.</th><th>Equipamento</th><th class="n">Qtd.</th><th class="n">Valor ref.</th></tr>
      ${c.itens.filter((i) => Number(i.saldo) !== 0).map((i) => `
        <tr class="${Number(i.saldo) < 0 ? 'negativo' : ''}"><td>${i.codprod}</td><td>${esc(i.produto)}</td>
        <td class="n">${num(i.saldo)}</td><td class="n">${moeda(Number(i.saldo) * Number(i.vlr_unit_ref || 0))}</td></tr>`).join('')
        || '<tr><td colspan="4" class="sutil">Nenhum equipamento no momento.</td></tr>'}
    </table>
    <h3>Movimentações</h3>
    <table>
      <tr><th>Data</th><th>Origem</th><th>Nota</th><th>Equipamento</th><th class="n">Qtd.</th></tr>
      ${(movs || []).map((m) => `
        <tr><td>${dataBR(m.data)}</td><td><span class="tag ${m.origem}">${nomeOrigem[m.origem]}</span></td>
        <td>${m.numnota ? 'NF ' + m.numnota + ' <span class="sutil">(TOP ' + m.codtipoper + ')</span>' : '—'}</td>
        <td>${esc(prodNome.get(m.codprod) || m.codprod)}</td><td class="n">${m.qtd > 0 ? '+' : ''}${num(m.qtd)}</td></tr>`).join('')}
    </table>`
}

$('btn-exportar').addEventListener('click', () => {
  const linhas = [['Cliente', 'CODPARC', 'Cod. produto', 'Equipamento', 'Quantidade', 'Valor unit. ref.', 'Valor total']]
  for (const c of clientesFiltrados()) {
    for (const i of c.itensFiltro) {
      if (Number(i.saldo) === 0) continue
      linhas.push([c.nome, c.codparc ?? '', i.codprod, i.produto, num(i.saldo), num(i.vlr_unit_ref), num(Number(i.saldo) * Number(i.vlr_unit_ref || 0))])
    }
  }
  const csv = '\ufeff' + linhas.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = `saldo-comodatos-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
})

// ---------------- NOTAS ----------------
async function carregarNotas() {
  notas = await buscarTudo(() => sb.from('cmd_notas')
    .select('nunota, numnota, codtipoper, tipo, dtneg, codparc, statusnota, observacao, vinculo_manual, cmd_clientes(nome), cmd_notas_itens(codprod, qtd)')
    .order('dtneg', { ascending: false }).order('nunota', { ascending: false }))
  desenharNotas()
  desenharGraficoMeses()
}

function desenharNotas() {
  const termo = $('busca-nota').value.trim().toUpperCase()
  const tipo = $('filtro-tipo').value
  const prodNome = new Map(saldo.map((l) => [l.codprod, l.produto]))
  const lista = notas.filter((n) => (!tipo || n.tipo === tipo) && (!termo ||
    String(n.numnota).includes(termo) || (n.cmd_clientes?.nome || '').toUpperCase().includes(termo) || (n.observacao || '').toUpperCase().includes(termo)))
  $('tabela-notas').innerHTML = `
    <thead><tr><th>Data</th><th>Tipo</th><th>NF</th><th>TOP</th><th>Cliente</th><th>Itens</th><th>Status</th></tr></thead>
    ${lista.slice(0, 500).map((n) => `
      <tr><td>${dataBR(n.dtneg)}</td><td><span class="tag ${n.tipo}">${n.tipo === 'REMESSA' ? 'Remessa' : 'Retorno'}</span></td>
      <td>${n.numnota ?? '—'}</td><td>${n.codtipoper}</td>
      <td>${n.cmd_clientes ? esc(n.cmd_clientes.nome) + (n.vinculo_manual ? ' <span class="sutil">(vinculado manualmente)</span>' : '') : '<span class="erro">a vincular</span>'}</td>
      <td>${(n.cmd_notas_itens || []).map((i) => `${num(i.qtd)}× ${esc(prodNome.get(i.codprod) || i.codprod)}`).join('<br>')}</td>
      <td>${n.statusnota === 'L' ? 'Confirmada' : '<span class="erro">Não confirmada</span>'}</td></tr>`).join('')}
    ${lista.length > 500 ? `<tr><td colspan="7" class="sutil">Mostrando 500 de ${lista.length}. Use a busca para filtrar.</td></tr>` : ''}`
}
;['busca-nota', 'filtro-tipo'].forEach((id) => $(id).addEventListener('input', desenharNotas))

// ---------------- RETORNOS PARA VINCULAR ----------------
async function carregarClientes() {
  todosClientes = await buscarTudo(() => sb.from('cmd_clientes').select('id, codparc, nome').order('nome'))
}

async function carregarPendentes() {
  const { data, error } = await sb.from('cmd_v_retornos_pendentes').select('*').order('dtneg', { ascending: false })
  if (error) throw error
  $('qtd-pendentes').textContent = data.length || ''
  const opcoes = todosClientes.map((c) => `<option value="${c.id} - ${esc(c.nome)}${c.codparc ? ' (Sankhya ' + c.codparc + ')' : ''}">`).join('')
  $('lista-pendentes').innerHTML = data.length ? data.map((n) => `
    <div class="pendente">
      <b>NF ${n.numnota}</b> — ${dataBR(n.dtneg)} — TOP ${n.codtipoper} ${n.statusnota !== 'L' ? '<span class="erro">(não confirmada)</span>' : ''}
      <div class="obs">${esc(n.observacao || 'Sem observação')}</div>
      <div class="sutil">${(n.itens || []).map((i) => `${num(i.qtd)}× ${esc(i.produto || i.codprod)}`).join(' · ')}</div>
      <div class="linha-botoes" style="margin-top:8px">
        <input list="dl-clientes" placeholder="Digite o nome do cliente..." data-nunota="${n.nunota}" />
        <button data-vincular="${n.nunota}">Vincular</button>
      </div>
    </div>`).join('') + `<datalist id="dl-clientes">${opcoes}</datalist>`
    : '<p>✅ Nenhum retorno pendente.</p>'

  document.querySelectorAll('[data-vincular]').forEach((b) => b.addEventListener('click', async () => {
    const nunota = Number(b.dataset.vincular)
    const valor = document.querySelector(`input[data-nunota="${nunota}"]`).value
    const id = Number(valor.split(' - ')[0])
    if (!id || !todosClientes.some((c) => c.id === id)) { aviso('Escolha um cliente da lista.'); return }
    b.disabled = true
    const { error: e2 } = await sb.rpc('cmd_vincular_retorno', { p_nunota: nunota, p_cliente_id: id })
    if (e2) { aviso('Erro: ' + e2.message, 8000); b.disabled = false; return }
    aviso('Retorno vinculado. Saldo atualizado.')
    await Promise.all([carregarSaldo(), carregarNotas()])
    await carregarPendentes()
  }))
}

// ---------------- PLANILHA INICIAL ----------------
async function carregarConfig() {
  const { data } = await sb.from('cmd_config').select('valor').eq('chave', 'data_corte_planilha').single()
  $('data-corte-atual').textContent = data?.valor ? dataBR(data.valor) : 'planilha ainda não importada'
  if (data?.valor) $('data-planilha').value = data.valor
}

// "2.500,00" -> 2500
const numBR = (s) => Number(String(s || '').replace(/\./g, '').replace(',', '.'))

// Le o lado esquerdo da planilha: Cliente;PLU;Produto;Qtd.emb;Vlr.unit.;Total liq.
function lerPlanilha(texto) {
  const linhas = texto.replace(/^\ufeff/, '').split(/\r?\n/)
  const saida = []
  linhas.forEach((l, idx) => {
    if (idx === 0) return // cabecalho
    const col = l.split(';')
    const cliente = (col[0] || '').trim()
    const codprod = parseInt(col[1], 10)
    const qtd = numBR(col[3])
    if (!cliente || !codprod || !qtd) return
    const m = cliente.match(/^([^-]+?)\s*-\s*(.*)$/)
    if (!m) return
    saida.push({ linha: idx + 1, codigo: m[1].trim(), nome: m[2].trim(), codprod, produto: (col[2] || '').trim(), qtd, vlrunit: numBR(col[4]) || null })
  })
  return saida
}

// Mostra o nome do arquivo escolhido (o campo de arquivo fica invisivel dentro da area pontilhada).
$('arquivo-planilha').addEventListener('change', () => {
  const arq = $('arquivo-planilha').files[0]
  $('area-arquivo').classList.toggle('ok', !!arq)
  $('nome-arquivo').innerHTML = arq ? `✅ <b>${esc(arq.name)}</b> selecionado — clique para trocar` : '📄 Clique aqui para escolher o <b>comodatos.csv</b>'
})
;['dragenter', 'dragover'].forEach((ev) => $('area-arquivo').addEventListener(ev, () => $('area-arquivo').classList.add('arrastando')))
;['dragleave', 'drop'].forEach((ev) => $('area-arquivo').addEventListener(ev, () => $('area-arquivo').classList.remove('arrastando')))

$('btn-importar').addEventListener('click', async () => {
  const arq = $('arquivo-planilha').files[0]
  const data = $('data-planilha').value
  if (!arq) { aviso('Escolha o arquivo CSV.'); return }
  if (!data) { aviso('Informe a data da planilha.'); return }
  if (/\.xlsx?$/i.test(arq.name)) { aviso('Esse arquivo é do Excel (.xlsx). Escolha o comodatos.csv.', 8000); return }
  // O Excel as vezes salva em ANSI (Windows-1252) em vez de UTF-8: tenta os dois.
  const bytes = await arq.arrayBuffer()
  let texto = new TextDecoder('utf-8').decode(bytes)
  if (texto.includes('\ufffd')) texto = new TextDecoder('windows-1252').decode(bytes)
  const linhas = lerPlanilha(texto)
  if (!linhas.length) { aviso('Não encontrei linhas válidas. O arquivo está em CSV separado por ponto e vírgula?', 8000); return }
  if (!confirm(`Importar ${linhas.length} linhas? As notas do Sankhya vão contar a partir de ${dataBR(data)}. O saldo inicial anterior será substituído.`)) return
  const b = $('btn-importar')
  b.disabled = true
  b.textContent = 'Importando...'
  const { data: res, error } = await sb.rpc('cmd_importar_planilha', { p_linhas: linhas, p_data_corte: data })
  b.disabled = false
  b.textContent = 'Importar'
  if (error) {
    $('resultado-importacao').innerHTML = `<p class="erro">❌ A importação falhou: ${esc(error.message)}</p>`
    aviso('Erro na importação: ' + error.message, 10000)
    return
  }
  $('resultado-importacao').innerHTML = `<p>✅ ${num(res.linhas)} linhas importadas, ${num(res.clientes)} clientes.
    ${res.clientes_sem_sankhya ? `<br>⚠ ${res.clientes_sem_sankhya} clientes sem código Sankhya (veja a lista abaixo).` : ''}</p>`
  await carregarTudo()
})

// Muda so a data a partir da qual as notas do Sankhya contam, sem reimportar a planilha.
$('btn-salvar-corte').addEventListener('click', async () => {
  const data = $('data-planilha').value
  if (!data) { aviso('Informe a data.'); return }
  const { error } = await sb.rpc('cmd_definir_data_corte', { p_data: data })
  if (error) { aviso('Erro: ' + error.message, 8000); return }
  aviso('Notas do Sankhya passam a contar a partir de ' + dataBR(data))
  await carregarTudo()
})

$('btn-sugerir').addEventListener('click', async () => {
  const { data, error } = await sb.rpc('cmd_sugerir_data_corte')
  if (error) { aviso('Erro: ' + error.message, 8000); return }
  if (!data?.length) { $('resultado-importacao').innerHTML = '<p class="sutil">Importe a planilha primeiro.</p>'; return }
  $('resultado-importacao').innerHTML = `<p>Datas em que as notas do Sankhya mais batem com a planilha
    (menor diferença = mais provável):</p><table><tr><th>Data</th><th class="n">Diferença (un.)</th><th></th></tr>
    ${data.map((d) => `<tr><td>${dataBR(d.data)}</td><td class="n">${num(d.diferenca)}</td>
      <td><button class="secundario" data-corte="${d.data}">Usar esta data</button></td></tr>`).join('')}</table>`
  document.querySelectorAll('[data-corte]').forEach((b) => b.addEventListener('click', async () => {
    const { error: e2 } = await sb.rpc('cmd_definir_data_corte', { p_data: b.dataset.corte })
    if (e2) { aviso('Erro: ' + e2.message, 8000); return }
    aviso('Data de corte alterada para ' + dataBR(b.dataset.corte))
    await carregarTudo()
  }))
})

async function carregarSemSankhya() {
  const { data, error } = await sb.from('cmd_v_clientes_sem_sankhya').select('*').not('qtd_planilha', 'is', null).order('nome')
  if (error) throw error
  $('lista-sem-sankhya').innerHTML = data.length ? `<table><tr><th>Cliente (planilha)</th><th>Código planilha</th><th class="n">Qtd.</th><th>CODPARC Sankhya</th></tr>
    ${data.map((c) => `<tr><td>${esc(c.nome)}</td><td>${esc(c.codigos)}</td><td class="n">${num(c.qtd_planilha)}</td>
      <td class="linha-botoes"><input type="number" min="1" data-ligar-input="${c.id}" style="width:110px" />
      <button class="secundario" data-ligar="${c.id}">Ligar</button></td></tr>`).join('')}</table>`
    : '<p>✅ Todos os clientes da planilha estão ligados ao Sankhya.</p>'
  document.querySelectorAll('[data-ligar]').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.ligar)
    const codparc = Number(document.querySelector(`[data-ligar-input="${id}"]`).value)
    if (!codparc) { aviso('Informe o CODPARC.'); return }
    const { error: e2 } = await sb.rpc('cmd_ligar_cliente_sankhya', { p_cliente_id: id, p_codparc: codparc })
    if (e2) { aviso('Erro: ' + e2.message, 8000); return }
    aviso('Cliente ligado ao Sankhya.')
    await carregarTudo()
  }))
}

iniciar()
