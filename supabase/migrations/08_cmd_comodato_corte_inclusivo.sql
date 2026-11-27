-- A data de corte passa a significar: "notas do Sankhya a partir desta data (inclusive) entram no saldo".
-- Saldo = planilha do Milenio + remessas/retornos do Sankhya com DTNEG >= data de corte.
create or replace view public.cmd_v_movimentos with (security_invoker = true) as
with corte as (
  select nullif(valor,'')::date as d from public.cmd_config where chave = 'data_corte_planilha'
)
select 'PLANILHA'::text as origem, s.cliente_id, s.codprod, s.qtd as qtd, s.vlrunit,
       (select d from corte) as data, null::bigint as nunota, null::bigint as numnota, null::integer as codtipoper
from public.cmd_saldo_inicial s
union all
select n.tipo, n.cliente_id, i.codprod,
       case when n.tipo = 'REMESSA' then i.qtd else -i.qtd end,
       i.vlrunit, n.dtneg, n.nunota, n.numnota, n.codtipoper
from public.cmd_notas n
join public.cmd_notas_itens i on i.nunota = n.nunota
where n.statusnota = 'L'
  and n.cliente_id is not null
  and n.dtneg >= coalesce((select d from corte), date '1900-01-01');

-- Sugestao de data: a planilha contem as notas ANTERIORES a data sugerida.
create or replace function public.cmd_sugerir_data_corte()
returns table (data date, diferenca numeric)
language sql stable security definer set search_path = public
as $$
  with plan as (
    select s.cliente_id, s.codprod, sum(s.qtd) qtd
      from public.cmd_saldo_inicial s
     where exists (select 1 from public.cmd_clientes_codigos k where k.cliente_id = s.cliente_id and k.codigo_planilha like 'S%')
     group by 1, 2
  ),
  datas as (select distinct dtneg d from public.cmd_notas where dtneg >= current_date - 180),
  mov as (
    select n.cliente_id, i.codprod, n.dtneg, case when n.tipo = 'REMESSA' then i.qtd else -i.qtd end q
      from public.cmd_notas n join public.cmd_notas_itens i on i.nunota = n.nunota
     where n.statusnota = 'L' and n.cliente_id in (select cliente_id from plan)
  )
  select d.d,
         (select coalesce(sum(abs(coalesce(p.qtd,0) - coalesce(m.q,0))),0)
            from (select cliente_id, codprod, sum(q) q from mov where dtneg < d.d group by 1,2) m
            full join plan p on p.cliente_id = m.cliente_id and p.codprod = m.codprod) diferenca
    from datas d order by 2, 1 desc limit 5;
$$;
revoke all on function public.cmd_sugerir_data_corte() from public, anon;
grant execute on function public.cmd_sugerir_data_corte() to authenticated;

update public.cmd_config set valor = '2026-10-23', atualizado_em = now() where chave = 'data_corte_planilha';
