-- Dados de exemplo para pam@gmail.com (rodar DEPOIS de criar o usuário em Authentication > Users)
do $$
declare u uuid; c uuid; ct uuid;
  r record;
begin
  select id into u from auth.users where email = 'pam@gmail.com';
  if u is null then raise exception 'Crie primeiro o usuário pam@gmail.com em Authentication > Users'; end if;

  for r in select * from (values
    ('Automação de atendimento','Clínica Vitta','Dra. Renata Alves','48998123301',12000,5,70,86,'Meta Ads',2,'Enviar contrato revisado',1),
    ('GEO + SEO 6 meses','Imobiliária Costa Sul','Felipe Mattos','48996201187',18000,4,50,78,'Google Ads',5,'Follow-up da proposta',0),
    ('Tráfego pago','Pousada Mar Azul','Juliana Reis','48991330420',4500,3,40,64,'Indicação',1,'Reunião de diagnóstico',2),
    ('Site Lovable + LP','Andrade Advocacia','Carlos Andrade','48984557712',7800,4,55,81,'LinkedIn',9,'Ligar para tirar dúvidas',0),
    ('Agente IA no WhatsApp','Rede Farma+','Patrícia Nunes','48997015523',24000,2,25,72,'Evento',3,'Mapear decisores',3),
    ('Automação de CRM','Construtora Horizonte','Rafael Lima','48999408812',15000,5,65,74,'Indicação',16,'Reativar: proposta parada',-2),
    ('Gestão de tráfego','Academia Pulse','Bruno Teixeira','48992116650',3600,1,10,41,'Meta Ads',0,'Primeiro contato',0),
    ('Consultoria de IA','Grupo Litoral','Mariana Souza','48998774410',32000,3,30,69,'Sapiens Park',4,'Workshop com diretoria',4),
    ('Social + Ads','Café Garopaba','Lucas Prado','48996540091',2800,1,10,35,'Instagram',1,'Qualificar orçamento',1),
    ('Automação financeira','Contabilidade Prisma','Ana Beatriz Costa','48993102276',9500,4,45,70,'Google Ads',18,'Proposta vence hoje',0),
    ('GEO para hotelaria','Hotel Imbituba Bay','Thiago Martins','48991283345',6200,2,20,58,'Orgânico',6,'Enviar case de hotel',2),
    ('Funil completo','EdTech Saber+','Camila Rocha','48990761120',21000,5,60,83,'LinkedIn',1,'Ajustar escopo da fase 1',1),
    ('Chatbot de vendas','Ótica Visão','Pedro Alves','48994562001',3200,6,100,90,'Meta Ads',3,'Onboarding',null),
    ('Tráfego + LP','Studio Pilates Core','Fernanda Lopes','48995817734',5400,6,100,88,'Indicação',5,'Onboarding',null),
    ('Automação de pós-venda','Auto Peças SC','Jorge Silva','48990024418',4800,1,10,47,'Google Ads',2,'Primeiro contato',0)
  ) as v(title,company,person,phone,value,stage,prob,score,src,idle,nxt,due) loop
    insert into public.companies(owner_id,name) values (u,r.company) returning id into c;
    insert into public.contacts(owner_id,company_id,name,phone,source,lead_score) values (u,c,r.person,r.phone,r.src,r.score) returning id into ct;
    insert into public.deals(owner_id,title,company_id,contact_id,stage_id,value,probability,score,source,next_action,next_action_at,last_activity_at,won_at)
      values (u,r.title,c,ct,r.stage,r.value,r.prob,r.score,r.src,r.nxt,case when r.due is null then null else current_date + r.due end,
              now() - make_interval(days => r.idle), case when r.stage = 6 then now() - make_interval(days => r.idle) end);
  end loop;

  insert into public.goals(owner_id,period_start,period_end,amount) values (u,date_trunc('month',current_date),(date_trunc('month',current_date)+interval '1 month - 1 day')::date,40000);

  insert into public.templates(owner_id,name,channel,body) values
   (u,'Pós-reunião','both','Oi {nome}! Obrigado pela conversa de hoje. Como combinamos, segue o resumo e os próximos passos para a {empresa}.'),
   (u,'Proposta sem resposta','both','Oi {nome}, tudo bem? Conseguiu avaliar a proposta de {negocio}? Faço uma call de 15 min para tirar dúvidas.'),
   (u,'Reativação','both','{nome}, preparei um material com números que pode ajudar na decisão sobre {negocio}. Posso te enviar?'),
   (u,'Objeção de preço','both','{nome}, montei uma alternativa: um piloto de 3 meses com parcelamento. Faz sentido para a {empresa}?'),
   (u,'Confirmar reunião','whatsapp','Oi {nome}! Confirmando nosso encontro amanhã. Continua de pé?'),
   (u,'Proposta vencendo','both','{nome}, a proposta de {negocio} vence hoje. Consigo estender por mais 7 dias. Quer?'),
   (u,'Pedir indicação','both','{nome}, conhece alguém que também poderia se beneficiar? Indicações ganham 1 mês de bônus.');
end $$;
