-- Um cliente pode aparecer na planilha com mais de um codigo (Milenio 000xxx e Sankhya Sxxx).
alter table public.cmd_clientes drop column codigo_planilha;

create table public.cmd_clientes_codigos (
  codigo_planilha text primary key,
  cliente_id bigint not null references public.cmd_clientes(id),
  nome_planilha text
);
alter table public.cmd_clientes_codigos enable row level security;
create policy cmd_clientes_codigos_ler on public.cmd_clientes_codigos for select to authenticated using (true);

-- (cmd_importar_planilha e substituida na migracao 04)

-- Sugere a data da planilha: compara o saldo da planilha dos clientes Sankhya (codigo Sxxx)
-- com o acumulado das notas ate cada data candidata e devolve as datas com menor diferenca.
create function public.cmd_sugerir_data_corte()
returns table (data date, diferenca numeric)
language sql
stable
security definer
set search_path = public
as $$
  with plan as (
    select s.cliente_id, s.codprod, sum(s.qtd) qtd
      from public.cmd_saldo_inicial s
     where exists (select 1 from public.cmd_clientes_codigos k where k.cliente_id = s.cliente_id and k.codigo_planilha like 'S%')
     group by 1, 2
  ),
  datas as (
    select distinct dtneg d from public.cmd_notas where dtneg >= current_date - 180
  ),
  mov as (
    select n.cliente_id, i.codprod, n.dtneg,
           case when n.tipo = 'REMESSA' then i.qtd else -i.qtd end q
      from public.cmd_notas n join public.cmd_notas_itens i on i.nunota = n.nunota
     where n.statusnota = 'L' and n.cliente_id in (select cliente_id from plan)
  )
  select d.d,
         (select coalesce(sum(abs(coalesce(p.qtd,0) - coalesce(m.q,0))),0)
            from (select cliente_id, codprod, sum(q) q from mov where dtneg <= d.d group by 1,2) m
            full join plan p on p.cliente_id = m.cliente_id and p.codprod = m.codprod) diferenca
    from datas d
   order by 2, 1 desc
   limit 5;
$$;
revoke all on function public.cmd_sugerir_data_corte() from public, anon;
grant execute on function public.cmd_sugerir_data_corte() to authenticated;
