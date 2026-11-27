-- Retornos de comodato lancados em TOPs que nao sao de comodato.
-- No Sankhya, devolucoes de equipamento tambem entraram nas TOPs 1986 (retorno de bens RECEBIDOS em comodato)
-- e 2025/2027 (devolucao de venda de terceiros). A planilha do Milenio nao abateu essas notas, por isso elas
-- contam desde o fim do Milenio (retornos_extras_desde), e nao so a partir da data de corte.
-- Nessas TOPs so entram os itens que sao equipamentos (as de devolucao de venda tambem trazem massas).

insert into public.cmd_config (chave, valor) values
  ('tops_retorno_so_equipamento', '1986,2025,2027'),
  ('retornos_extras_desde', '2026-04-30')
on conflict (chave) do update set valor = excluded.valor;
update public.cmd_config set valor = '1256,1271,1997,1986,2025,2027' where chave = 'tops_retorno';

-- Nota que nao deve entrar no saldo (ex.: equipamento devolvido sem registro de comodato).
alter table public.cmd_notas
  add column ignorar boolean not null default false,
  add column motivo_ignorar text;

-- Equipamentos = tudo que ja saiu em comodato (planilha + remessas).
create or replace view public.cmd_v_equipamentos with (security_invoker = true) as
  select codprod from public.cmd_saldo_inicial
  union
  select i.codprod from public.cmd_notas_itens i join public.cmd_notas n on n.nunota = i.nunota where n.tipo = 'REMESSA';

create or replace view public.cmd_v_movimentos with (security_invoker = true) as
with cfg as (
  select
    (select nullif(valor, '')::date from public.cmd_config where chave = 'data_corte_planilha') as corte,
    (select nullif(valor, '')::date from public.cmd_config where chave = 'retornos_extras_desde') as desde_extras,
    (select string_to_array(replace(coalesce(valor, ''), ' ', ''), ',')::int[]
       from public.cmd_config where chave = 'tops_retorno_so_equipamento') as tops_extras
)
select 'PLANILHA'::text as origem, s.cliente_id, s.codprod, s.qtd, s.vlrunit,
       (select corte from cfg) as data, null::bigint as nunota, null::bigint as numnota, null::integer as codtipoper
  from public.cmd_saldo_inicial s
union all
select n.tipo as origem, n.cliente_id, i.codprod,
       case when n.tipo = 'REMESSA' then i.qtd else -i.qtd end as qtd,
       i.vlrunit, n.dtneg as data, n.nunota, n.numnota, n.codtipoper
  from public.cmd_notas n
  join public.cmd_notas_itens i on i.nunota = n.nunota
  cross join cfg
 where n.statusnota = 'L' and n.cliente_id is not null and not n.ignorar
   and n.dtneg >= case when n.codtipoper = any (coalesce(cfg.tops_extras, '{}'))
                       then coalesce(cfg.desde_extras, cfg.corte, '1900-01-01')
                       else coalesce(cfg.corte, '1900-01-01') end;

create or replace view public.cmd_v_retornos_pendentes with (security_invoker = true) as
select nunota, numnota, codtipoper, dtneg, codparc, observacao, statusnota,
       (select jsonb_agg(jsonb_build_object('codprod', i.codprod, 'produto', p.descricao, 'qtd', i.qtd) order by i.sequencia)
          from public.cmd_notas_itens i left join public.cmd_produtos p on p.codprod = i.codprod
         where i.nunota = n.nunota) as itens
  from public.cmd_notas n
 where cliente_id is null and not ignorar;

-- Seguranca: esta view rodava com os direitos do dono (ignorava o RLS) e estava aberta ao anon.
alter view public.cmd_v_sugestao_vinculo set (security_invoker = true);

-- Nenhum objeto dos comodatos fica acessivel sem login.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname like 'cmd\_%' and c.relkind in ('r', 'v', 'S') loop
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;
end $$;
