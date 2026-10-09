-- A payment option somebody chose is no longer editable
-- ===========================================================================
--
-- Leif configures what each programme offers: Pay in Full, Monthly, Financial
-- Need, the scholarship variants. Those rows were a generic admin table —
-- checkboxes, Select all, Export, Delete — and they were freely mutable.
--
-- They are not free to mutate. `deals.selected_payment_option_id` points at
-- one, and `stripe_checkout` re-read that row's LIVE amounts when charging a
-- prospect who had already been shown the Deal's snapshot of them. Edit the
-- option in between and the page said one number while Stripe charged
-- another. Nobody had done it, because there was no comfortable way to edit;
-- building one without this migration would have made it easy.
--
-- Leif's rule, and the shape of everything below: AN OPTION IS A VERSIONED
-- PROGRAMME TEMPLATE. The moment a Deal selects one, that row is somebody's
-- agreement and is never rewritten. Editing it creates the next version and
-- retires the old one; the Deal keeps pointing at what it agreed to.

begin;

-- ---------------------------------------------------------------------------
-- 1. Still offered, which is NOT the same question as publicly listed
-- ---------------------------------------------------------------------------
-- is_public already exists and answers a different question: whether an
-- option is shown to everyone or authorised case by case (Financial Need is
-- public = false and very much still offered). Reusing it for "withdrawn"
-- would have collapsed two independent dimensions into one and quietly made
-- every case-by-case option look retired.
alter table public.offer_payment_options
  add column if not exists is_active boolean not null default true;

-- Which option this one replaced, so a version chain is readable rather than
-- inferred from timestamps and names. Null for an original.
alter table public.offer_payment_options
  add column if not exists replaces_option_id bigint;

alter table public.offer_payment_options
  drop constraint if exists offer_payment_options_replaces_option_id_fkey;
alter table public.offer_payment_options
  add constraint offer_payment_options_replaces_option_id_fkey
  foreign key (replaces_option_id) references public.offer_payment_options(id)
  on update cascade;

-- A version cannot replace itself.
alter table public.offer_payment_options
  drop constraint if exists offer_payment_options_replaces_another_check;
alter table public.offer_payment_options
  add constraint offer_payment_options_replaces_another_check
  check (replaces_option_id is null or replaces_option_id <> id);

create index if not exists offer_payment_options_active_idx
  on public.offer_payment_options using btree (offer_id, is_active);

-- ---------------------------------------------------------------------------
-- 2. One door, because the rule is only as good as its enforcement
-- ---------------------------------------------------------------------------
-- Nothing in the application wrote these rows (the admin table's Delete was
-- the only writer, and it is going away), so closing them costs nothing and
-- makes "a referenced option is never mutated" a property of the database
-- rather than a habit of the UI.
revoke insert, update, delete on table public.offer_payment_options from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Add, or edit — and edit means version when somebody already chose it
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the table is now closed to the browser. The
-- reference count and the write happen in ONE transaction with the option row
-- locked, so an option cannot acquire its first Deal between the check and
-- the update.
--
-- Leif never chooses between "edit" and "version". She saves; this decides,
-- and tells the caller which happened so the page can say something true.
create or replace function public.set_offer_payment_option(
  p_offer_id bigint,
  p_name text,
  p_total numeric,
  p_installments smallint,
  p_installment_amount numeric,
  p_is_public boolean default true,
  p_pricing_mode text default 'standard',
  p_option_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing offer_payment_options%rowtype;
  v_references int;
  v_new_id bigint;
begin
  if not exists (select 1 from offers where id = p_offer_id) then
    return jsonb_build_object('status', 'offer-invalid');
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    return jsonb_build_object('status', 'name-required');
  end if;
  if p_pricing_mode not in ('standard', 'scholarship') then
    return jsonb_build_object('status', 'pricing-mode-invalid');
  end if;
  if p_installments is null or p_installments < 1 then
    return jsonb_build_object('status', 'installments-invalid');
  end if;
  if p_total is null or p_total < 0
     or p_installment_amount is null or p_installment_amount < 0 then
    return jsonb_build_object('status', 'amount-invalid');
  end if;
  -- The same arithmetic stripe_checkout refuses to charge on: an instalment
  -- plan that does not add up is a number nobody can honour.
  if p_installments > 1
     and round(p_installment_amount * p_installments, 2) <> round(p_total, 2) then
    return jsonb_build_object(
      'status', 'instalments-do-not-add-up',
      'total', p_total,
      'reconstructed', round(p_installment_amount * p_installments, 2));
  end if;

  -- ---- a new one -----------------------------------------------------------
  if p_option_id is null then
    insert into offer_payment_options
      (offer_id, name, total, installments, installment_amount, is_public, pricing_mode)
    values
      (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
       coalesce(p_is_public, true), p_pricing_mode)
    returning id into v_new_id;
    return jsonb_build_object('status', 'added', 'option_id', v_new_id);
  end if;

  -- ---- an existing one -----------------------------------------------------
  select * into v_existing from offer_payment_options
   where id = p_option_id for update;
  if v_existing.id is null then
    return jsonb_build_object('status', 'option-invalid');
  end if;
  if v_existing.offer_id <> p_offer_id then
    return jsonb_build_object('status', 'option-not-of-this-offer');
  end if;

  select count(*) into v_references
    from deals where selected_payment_option_id = p_option_id;

  if v_references = 0 then
    -- Nobody agreed to it, so there is no agreement to protect.
    update offer_payment_options
       set name = btrim(p_name),
           total = p_total,
           installments = p_installments,
           installment_amount = p_installment_amount,
           is_public = coalesce(p_is_public, true),
           pricing_mode = p_pricing_mode,
           updated_at = now()
     where id = p_option_id;
    return jsonb_build_object('status', 'updated', 'option_id', p_option_id);
  end if;

  -- Somebody chose this. The row stays exactly as they agreed to it, stops
  -- being offered, and the edit becomes the next version.
  insert into offer_payment_options
    (offer_id, name, total, installments, installment_amount, is_public,
     pricing_mode, replaces_option_id)
  values
    (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
     coalesce(p_is_public, true), p_pricing_mode, p_option_id)
  returning id into v_new_id;

  update offer_payment_options set is_active = false, updated_at = now()
   where id = p_option_id;

  return jsonb_build_object(
    'status', 'versioned',
    'option_id', v_new_id,
    'replaced_option_id', p_option_id,
    'agreements_preserved', v_references);
end;
$$;

-- Stop offering one. Never a delete: an option nobody chose is still a record
-- of what the programme once offered, and one somebody chose is their
-- agreement.
create or replace function public.set_offer_payment_option_active(
  p_option_id bigint,
  p_is_active boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing offer_payment_options%rowtype;
begin
  select * into v_existing from offer_payment_options
   where id = p_option_id for update;
  if v_existing.id is null then
    return jsonb_build_object('status', 'option-invalid');
  end if;

  update offer_payment_options
     set is_active = coalesce(p_is_active, false), updated_at = now()
   where id = p_option_id;

  return jsonb_build_object(
    'status', 'set', 'option_id', p_option_id,
    'is_active', coalesce(p_is_active, false));
end;
$$;

revoke all on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint) from public;
revoke all on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint) from anon;
grant execute on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint) to authenticated;
grant execute on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint) to service_role;

revoke all on function public.set_offer_payment_option_active(bigint, boolean) from public;
revoke all on function public.set_offer_payment_option_active(bigint, boolean) from anon;
grant execute on function public.set_offer_payment_option_active(bigint, boolean) to authenticated;
grant execute on function public.set_offer_payment_option_active(bigint, boolean) to service_role;

commit;
