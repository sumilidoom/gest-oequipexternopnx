create or replace function public.cmd_normaliza(t text)
returns text language sql immutable as $$
  select regexp_replace(upper(trim(translate(coalesce(t,''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))), '\s+', ' ', 'g')
$$;

-- Clientes da planilha que nao foram ligados a um parceiro Sankhya (para conferencia/ajuste).
create view public.cmd_v_clientes_sem_sankhya with (security_invoker = true) as
select c.id, c.nome, string_agg(k.codigo_planilha, ', ') codigos,
       (select sum(qtd) from public.cmd_saldo_inicial s where s.cliente_id = c.id) qtd_planilha
from public.cmd_clientes c
left join public.cmd_clientes_codigos k on k.cliente_id = c.id
where c.codparc is null
group by c.id, c.nome;

-- Liga manualmente um cliente da planilha a um parceiro Sankhya (junta os dois cadastros).
create function public.cmd_ligar_cliente_sankhya(p_cliente_id bigint, p_codparc integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_destino bigint;
begin
  if auth.uid() is null then raise exception 'login necessario'; end if;
  select id into v_destino from public.cmd_clientes where codparc = p_codparc;
  if v_destino is null then
    update public.cmd_clientes set codparc = p_codparc, atualizado_em = now() where id = p_cliente_id;
  elsif v_destino <> p_cliente_id then
    update public.cmd_saldo_inicial set cliente_id = v_destino where cliente_id = p_cliente_id;
    update public.cmd_clientes_codigos set cliente_id = v_destino where cliente_id = p_cliente_id;
    update public.cmd_notas set cliente_id = v_destino where cliente_id = p_cliente_id;
    delete from public.cmd_clientes where id = p_cliente_id;
  end if;
end $$;
revoke all on function public.cmd_ligar_cliente_sankhya(bigint, integer) from public, anon;
grant execute on function public.cmd_ligar_cliente_sankhya(bigint, integer) to authenticated;

-- Importa a planilha (substitui o saldo inicial inteiro).
-- p_linhas: [{"linha":2,"codigo":"000374","nome":"BRASIL ATACAREJO JUAZEIRO","codprod":6995,"produto":"ESTUFA...","qtd":4,"vlrunit":2500}, ...]
create or replace function public.cmd_importar_planilha(p_linhas jsonb, p_data_corte date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  v_codigo text;
  v_nome text;
  v_codparc integer;
  v_cliente bigint;
  v_linhas int := 0;
  v_ids bigint[];
begin
  if auth.uid() is null then raise exception 'login necessario'; end if;
  if p_data_corte is null then raise exception 'informe a data da planilha'; end if;

  delete from public.cmd_saldo_inicial;

  for r in select * from jsonb_array_elements(p_linhas) loop
    v_codigo := trim(r->>'codigo');
    v_nome := trim(coalesce(r->>'nome',''));
    if v_codigo is null or v_codigo = '' then continue; end if;
    v_cliente := null; v_codparc := null;

    select cliente_id into v_cliente from public.cmd_clientes_codigos where codigo_planilha = v_codigo;

    if v_cliente is null then
      if v_codigo ~ '^S[0-9]+$' then
        -- Sxxx = CODPARC do Sankhya
        v_codparc := substr(v_codigo, 2)::integer;
      else
        -- 000xxx = Milenio: liga pelo nome (o nome do Milenio vem cortado em ~24 letras).
        select array_agg(distinct c.codparc) into v_ids
          from public.cmd_clientes c
         where c.codparc is not null
           and public.cmd_normaliza(c.nome) like public.cmd_normaliza(v_nome) || '%';
        if array_length(v_ids, 1) is null then
          select array_agg(distinct d.codparc) into v_ids
            from public.dim_cliente_sankhya d
           where public.cmd_normaliza(d.nomeparc) like public.cmd_normaliza(v_nome) || '%';
        end if;
        if array_length(v_ids, 1) = 1 then v_codparc := v_ids[1]; end if;
      end if;

      if v_codparc is not null then
        insert into public.cmd_clientes (codparc, nome) values (v_codparc, coalesce(nullif(v_nome,''), v_codigo))
        on conflict (codparc) do update set atualizado_em = now()
        returning id into v_cliente;
      else
        insert into public.cmd_clientes (codparc, nome) values (null, coalesce(nullif(v_nome,''), v_codigo))
        returning id into v_cliente;
      end if;

      insert into public.cmd_clientes_codigos (codigo_planilha, cliente_id, nome_planilha)
      values (v_codigo, v_cliente, v_nome);
    end if;

    insert into public.cmd_produtos (codprod, descricao)
    values ((r->>'codprod')::integer, coalesce(nullif(r->>'produto',''), 'PRODUTO ' || (r->>'codprod')))
    on conflict (codprod) do nothing;

    insert into public.cmd_saldo_inicial (cliente_id, codprod, qtd, vlrunit, linha_planilha)
    values (v_cliente, (r->>'codprod')::integer, (r->>'qtd')::numeric, nullif(r->>'vlrunit','')::numeric, (r->>'linha')::integer);

    v_linhas := v_linhas + 1;
  end loop;

  update public.cmd_config set valor = p_data_corte::text, atualizado_em = now() where chave = 'data_corte_planilha';

  return jsonb_build_object(
    'linhas', v_linhas,
    'clientes', (select count(distinct cliente_id) from public.cmd_saldo_inicial),
    'clientes_sem_sankhya', (select count(*) from public.cmd_v_clientes_sem_sankhya where qtd_planilha is not null));
end;
$$;
revoke all on function public.cmd_importar_planilha(jsonb, date) from public, anon;
grant execute on function public.cmd_importar_planilha(jsonb, date) to authenticated;
