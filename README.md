# gest-oequipexternopnx — Comodatos Pannemix

Mostra, para cada cliente, quais equipamentos em comodato ele tem hoje, com o saldo atualizado sozinho a partir das notas do Sankhya.

## Como o saldo é calculado

```
saldo = planilha do Milênio (foto na data de corte)
      + remessas Sankhya (TOP 1156) depois da data de corte
      − retornos Sankhya (TOP 1256, 1271, 1997) depois da data de corte
```

Só contam notas confirmadas (STATUSNOTA = L).

## Partes do sistema

| Parte | Onde fica |
|---|---|
| Tabelas `cmd_*` e views `cmd_v_*` | Supabase (projeto `sistemacomercialpnx`) — SQL em `supabase/migrations/` |
| Função `cmd-sync-sankhya` (somente leitura no Sankhya) | Supabase Edge Functions — código em `supabase/functions/cmd-sync-sankhya/` |
| Agendamento a cada 5 min (últimos 15 dias) + releitura completa diária às 03:40 UTC | `pg_cron`: `cmd_comodato_sync_5min`, `cmd_comodato_sync_completo_diario` |
| Tela (`index.html`, `app.js`, `style.css`, `config.js`) | Este repositório |

## Usar a tela

Abra `index.html` no navegador e entre com um usuário do Supabase da Pannemix.

- **Saldo por cliente**: o que cada loja tem, com o histórico de notas. Tem exportação para CSV.
- **Histórico de notas**: todas as remessas e retornos.
- **Retornos para vincular**: retornos emitidos no nome da própria Pannemix (CODPARC 1). Escolha o cliente certo pela observação da nota.
- **Planilha inicial**: importa a planilha do Milênio (CSV UTF-8, separado por `;`) e define a data de corte.

> ⚠️ Planilhas (`.csv`, `.xlsx`) estão no `.gitignore` e nunca devem ir para o GitHub, porque o repositório é público.
