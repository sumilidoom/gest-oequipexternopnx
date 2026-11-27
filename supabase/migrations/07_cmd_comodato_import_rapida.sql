-- Correcao da importacao da planilha:
-- 1) O projeto usa pg_safeupdate, que bloqueia DELETE sem WHERE (era o erro "DELETE requires a WHERE clause").
-- 2) Nomes normalizados uma unica vez e insercao em lote, para caber no limite de tempo do banco (~0,3s para 1.900 linhas).
create or replace function public.cmd_importar_planilha(p_linhas jsonb, p_data_corte date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_codparc integer;
  v_cliente bigint;
  v_ids integer[];
  v_linhas int;
begin
  if auth.uid() is null then raise exception 'login necessario'; end if;
  if p_data_corte is null then raise exception 'informe a data da planilha'; end if;

  create temp table if not exists tmp_cmd_cand (codparc integer, nome_norm text) on commit drop;
  truncate tmp_cmd_cand;
  insert into tmp_cmd_cand
    select codparc, public.cmd_normaliza(nome) from public.cmd_clientes where codparc is not null
    union
    select codparc, public.cmd_normaliza(nomeparc) from public.dim_cliente_sankhya;

  -- 1) Resolve cada codigo novo da planilha uma unica vez.
  for r in
    select distinct on (trim(e->>'codigo')) trim(e->>'codigo') codigo, trim(coalesce(e->>'nome','')) nome
      from jsonb_array_elements(p_linhas) e
     where coalesce(trim(e->>'codigo'),'') <> ''
       and not exists (select 1 from public.cmd_clientes_codigos k where k.codigo_planilha = trim(e->>'codigo'))
  loop
    v_codparc := null; v_ids := null; v_cliente := null;
    if r.codigo ~ '^S[0-9]+$' then
      v_codparc := substr(r.codigo, 2)::integer;
    elsif r.nome <> '' then
      select array_agg(distinct codparc) into v_ids
        from tmp_cmd_cand where nome_norm like public.cmd_normaliza(r.nome) || '%';
      if array_length(v_ids, 1) = 1 then v_codparc := v_ids[1]; end if;
    end if;

    if v_codparc is not null then
      insert into public.cmd_clientes (codparc, nome) values (v_codparc, coalesce(nullif(r.nome,''), r.codigo))
      on conflict (codparc) do update set atualizado_em = now()
      returning id into v_cliente;
    else
      insert into public.cmd_clientes (codparc, nome) values (null, coalesce(nullif(r.nome,''), r.codigo))
      returning id into v_cliente;
    end if;
    insert into public.cmd_clientes_codigos (codigo_planilha, cliente_id, nome_planilha) values (r.codigo, v_cliente, r.nome);
  end loop;

  -- 2) Produtos e saldo inicial em lote.
  insert into public.cmd_produtos (codprod, descricao)
  select distinct on ((e->>'codprod')::integer) (e->>'codprod')::integer, coalesce(nullif(e->>'produto',''), 'PRODUTO ' || (e->>'codprod'))
    from jsonb_array_elements(p_linhas) e
   where coalesce(trim(e->>'codigo'),'') <> ''
  on conflict (codprod) do nothing;

  delete from public.cmd_saldo_inicial where id is not null;

  insert into public.cmd_saldo_inicial (cliente_id, codprod, qtd, vlrunit, linha_planilha)
  select k.cliente_id, (e->>'codprod')::integer, (e->>'qtd')::numeric, nullif(e->>'vlrunit','')::numeric, (e->>'linha')::integer
    from jsonb_array_elements(p_linhas) e
    join public.cmd_clientes_codigos k on k.codigo_planilha = trim(e->>'codigo');
  get diagnostics v_linhas = row_count;

  update public.cmd_config set valor = p_data_corte::text, atualizado_em = now() where chave = 'data_corte_planilha';

  return jsonb_build_object(
    'linhas', v_linhas,
    'clientes', (select count(distinct cliente_id) from public.cmd_saldo_inicial),
    'clientes_sem_sankhya', (select count(*) from public.cmd_v_clientes_sem_sankhya where qtd_planilha is not null));
end;
$$;
revoke all on function public.cmd_importar_planilha(jsonb, date) from public, anon;
grant execute on function public.cmd_importar_planilha(jsonb, date) to authenticated;
