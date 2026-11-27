# gest-oequipexternopnx — Comodatos Pannemix

Mostra, para cada cliente, quais equipamentos em comodato ele tem hoje, com o saldo atualizado sozinho a partir das notas do Sankhya.

## Como o saldo é calculado

```
saldo = planilha do Milênio (foto na data de corte)
      + remessas Sankhya (TOP 1156) depois da data de corte
      − retornos Sankhya (TOP 1256, 1271, 1997) depois da data de corte
      − retornos lançados em outras TOPs (1986, 2025, 2027) desde 30/04/2026, só os itens que são equipamento
```

Só contam notas confirmadas (STATUSNOTA = L). As TOPs 1986, 2025 e 2027 não são de comodato, mas foram usadas para devolver equipamento; a planilha do Milênio não as abateu, por isso contam desde o fim do Milênio (`retornos_extras_desde` em `cmd_config`). Uma nota pode ser tirada do saldo com `cmd_notas.ignorar = true` (e o motivo em `motivo_ignorar`).

## Partes do sistema

| Parte | Onde fica |
|---|---|
| Tabelas `cmd_*` e views `cmd_v_*` | Supabase (projeto `sistemacomercialpnx`) — SQL em `supabase/migrations/` |
| Função `cmd-login` (login com usuário e senha do Sankhya) | Supabase Edge Functions — código em `supabase/functions/cmd-login/` |
| Função `cmd-sync-sankhya` (somente leitura no Sankhya) | Supabase Edge Functions — código em `supabase/functions/cmd-sync-sankhya/` |
| Agendamento a cada 5 min (últimos 15 dias) + releitura completa diária às 03:40 UTC | `pg_cron`: `cmd_comodato_sync_5min`, `cmd_comodato_sync_completo_diario` |
| Tela (`index.html`, `app.js`, `style.css`, `config.js`) | Este repositório |

## Usar a tela

Abra `index.html` no navegador e entre com o **usuário e a senha do Sankhya** (igual ao Sistema Coletor). A função `cmd-login` confere a senha no Sankhya, que nunca é gravada, e abre a sessão. Só quem entrou assim enxerga os comodatos; logins de outros sistemas do mesmo Supabase não têm acesso.

Para bloquear alguém: `update cmd_usuarios set ativo = false where nomusu = 'FULANO';`

- **Saldo por cliente**: o que cada loja tem, com o histórico de notas. Tem exportação para CSV.
- **Histórico de notas**: todas as remessas e retornos.
- **Retornos para vincular**: retornos emitidos no nome da própria Pannemix (CODPARC 1). Escolha o cliente certo pela observação da nota.
- **Planilha inicial**: importa a planilha do Milênio (CSV UTF-8, separado por `;`) e define a data de corte.

> ⚠️ Planilhas (`.csv`, `.xlsx`) estão no `.gitignore` e nunca devem ir para o GitHub, porque o repositório é público.
