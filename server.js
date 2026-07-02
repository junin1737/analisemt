'use strict';
const express = require('express');
const Firebird = require('node-firebird');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'Painel')));

let dbConfig = {
  host: '127.0.0.1',
  port: 3050,
  database: 'C:/Work/MT/AnaliseCliente/Banco/CLIPP.FDB',
  user: 'SYSDBA',
  password: 'masterkey',
  lowercase_keys: false,
  charset: 'UTF8',
  pageSize: 4096
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function r2(n) { return n === null || n === undefined ? 0 : parseFloat(Number(n).toFixed(2)); }
function ri(n) { return n === null || n === undefined ? 0 : Math.round(Number(n)); }

function attachDb(cfg) {
  return new Promise((res, rej) =>
    Firebird.attach(cfg || dbConfig, (err, db) => err ? rej(err) : res(db)));
}

function q(db, sql) {
  return new Promise((res, rej) =>
    db.query(sql, (err, rows) => err ? rej(err) : res(rows || [])));
}

function getDateRange() {
  const now = new Date();
  const endYear  = now.getFullYear();
  const endMonth = now.getMonth() + 1;           // 1-12
  const endDate  = `${endYear}-${String(endMonth).padStart(2,'0')}-01`;
  const sd = new Date(now.getFullYear(), now.getMonth() - 18, 1);
  const startDate = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-01`;
  return { startDate, endDate };
}

function generateMonths(s, e) {
  const months = [];
  let [y, m] = s.split('-').map(Number);
  const [ey, em] = e.split('-').map(Number);
  while (y < ey || (y === ey && m < em)) {
    months.push({ ano: y, mes: m });
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

function zeroFill(months, rows, keyFn, mapFn) {
  const byKey = {};
  rows.forEach(r => { byKey[keyFn(r)] = r; });
  return months.map(m => mapFn(m, byKey[`${m.ano}-${m.mes}`] || null));
}

const FORMA_MAP = {
  'Cartao de Credito': 'Cartão de Crédito',
  'Cartao de Debito':  'Cartão de Débito',
  'Pagamento Instantâneo (PIX)': 'PIX', 'Pix': 'PIX',
};
const FORMA_COLORS = {
  'Prazo':'#c62828','Cartão de Crédito':'#2c3e6b','PIX':'#2e7d32',
  'Cartão de Débito':'#5b7bb0','Dinheiro':'#e08e0b','Depósito Bancário':'#888','Cheque':'#6d4c41',
};
const AGING_LABELS = {
  '1':{faixa:'1-30d',cor:'#e08e0b'},'2':{faixa:'31-60d',cor:'#e0760b'},
  '3':{faixa:'61-90d',cor:'#d9590b'},'4':{faixa:'91-180d',cor:'#cf3d0b'},
  '5':{faixa:'181-365d',cor:'#c62828'},'6':{faixa:'+365d',cor:'#7a1414'},
};
const CLASSIFICACAO = {
  'Mercadorias para Revenda':'CMV','Fornecedores - Contas a Pagar':'CMV',
  'Pró-Labore a Pagar':'Fixa','Outras contas a pagar':'Fixa','Salários a Pagar':'Fixa',
  'Aluguéis':'Fixa','Simples Nacional':'Variavel','Outras Despesas Operacionais':'Fixa',
  'Aplicações (exerc. seguinte)':'NaoOperacional','Prestação de Serviços PJ':'Fixa',
  'Outros Investimentos':'NaoOperacional','Outros tributos a Recolher':'Variavel',
  'Outros Gastos com Pessoal':'Fixa','Despesas com Alimentação':'Fixa',
  'ICMS e Contribuições a Recolher':'Variavel','Demais Impostos e Taxas':'Variavel',
  'FGTS a Recolher':'Fixa','Adiantamentos de Clientes':'NaoOperacional',
  'Marketing Digital':'Fixa','Taxa de Cartão de Crédito':'Variavel','Contabilidade':'Fixa',
  'Tributos Municipais a Recolher':'Variavel','Pacote Entrada de NFs':'Fixa',
  'Consultoria':'Fixa','Energia Elétrica':'Fixa','Material de Escritório':'Fixa',
  'Água':'Fixa','Telefone':'Fixa','Taxas e Tarifas Bancárias':'Fixa',
  'Assessoria Jurídica':'Fixa','(-) Duplicatas Descontadas':'NaoOperacional',
  'Antecipação/Distribuição de Lucros':'NaoOperacional','Encargos Sociais - Outros':'Fixa',
  'Móveis e Instalações':'NaoOperacional','Encargos Sociais - INSS':'Fixa',
  'Software ou Programas de Computador':'Fixa','Despesas com Veículos':'Fixa',
  'Fretes e Carretos':'Variavel','Encargos Sociais - FGTS':'Fixa','CDL':'Fixa',
  'Propaganda e publicidade':'Fixa','Computadores e Periféricos':'NaoOperacional',
  'Combustível e Lubrificantes':'Fixa','Cheque':'Fixa',
};
function normForma(f) { return FORMA_MAP[f] || f; }
function formaColor(f) { return FORMA_COLORS[f] || '#aaa'; }

// ─── All queries in ONE sequential connection ────────────────────────────────
async function buildDados(s, e, months) {

  const db = await attachDb();
  console.log('DB attached, running queries sequentially...');

  try {
    // ── VENDAS ──────────────────────────────────────────────────────────────
    const mensalR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      COUNT(DISTINCT N.ID_NFVENDA) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL, SUM(I.VLR_DESC) DESCONTO
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);

    const vendR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      F.NOME, COUNT(DISTINCT N.ID_NFVENDA) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FUNCIONARIO F ON F.ID_FUNCIONARIO=N.ID_VENDEDOR
      WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2,3 ORDER BY 1,2,5 DESC`);
    console.log('vendas mensal+vendedoras OK');

    const pagR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      F.DESCRICAO FORMA, SUM(P.VLR_PAGTO) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND N.NF_MODELO IN ('65','GR') AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`);
    console.log('pagamento OK');

    const fiscR = await q(db, `SELECT F.DESCRICAO FORMA,
      SUM(CASE WHEN N.NF_MODELO='65' THEN P.VLR_PAGTO ELSE 0 END) FISCAL,
      SUM(CASE WHEN N.NF_MODELO='GR' THEN P.VLR_PAGTO ELSE 0 END) GERENCIAL
      FROM TB_NFVENDA N JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND N.NF_MODELO IN ('65','GR')
      GROUP BY F.DESCRICAO ORDER BY SUM(P.VLR_PAGTO) DESC`);

    const cltR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      CASE WHEN C.NOME IN ('CLIENTES DIVERSOS','A VISTA','CLIENTES SEM FICHA LANÇADA') THEN 'Genérico' ELSE 'Identificado' END TIPO,
      SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_CLIENTE C ON C.ID_CLIENTE=N.ID_CLIENTE
      WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
        AND NOT EXISTS (
          SELECT 1 FROM TB_NFVENDA_FMAPAGTO_NFCE P2
          JOIN TB_FORMA_PAGTO_NFCE F2 ON F2.ID_FMANFCE=P2.ID_FMANFCE
          WHERE P2.ID_NFVENDA=N.ID_NFVENDA AND F2.DESCRICAO='Prazo'
        )
      GROUP BY EXTRACT(YEAR FROM N.DT_EMISSAO), EXTRACT(MONTH FROM N.DT_EMISSAO),
               CASE WHEN C.NOME IN ('CLIENTES DIVERSOS','A VISTA','CLIENTES SEM FICHA LANÇADA') THEN 'Genérico' ELSE 'Identificado' END
      ORDER BY 1,2`);
    console.log('fiscalização+clientes OK');

    const nfR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      COUNT(DISTINCT N.ID_NFVENDA) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO='GR' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);

    const cancR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      COUNT(DISTINCT N.ID_NFVENDA) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='C' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);

    const cancGR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      COUNT(DISTINCT N.ID_NFVENDA) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='C' AND N.NF_MODELO='GR' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);
    console.log('cancelamentos OK');

    const top15R = await q(db, `SELECT EI.ID_ESTOQUE
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_EST_IDENTIFICADOR EI ON EI.ID_IDENTIFICADOR=I.ID_IDENTIFICADOR
      WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY EI.ID_ESTOQUE ORDER BY SUM(I.QTD_ITEM) DESC ROWS 15`);

    let prodR = [];
    if (top15R.length) {
      const ids = top15R.map(r => r.ID_ESTOQUE).join(',');
      prodR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
        E.DESCRICAO NOME, SUM(I.QTD_ITEM) QTD, SUM(I.VLR_TOTAL-I.VLR_DESC) TOTAL
        FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
        JOIN TB_EST_IDENTIFICADOR EI ON EI.ID_IDENTIFICADOR=I.ID_IDENTIFICADOR
        JOIN TB_ESTOQUE E ON E.ID_ESTOQUE=EI.ID_ESTOQUE
        WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
          AND EI.ID_ESTOQUE IN (${ids})
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`);
    }
    console.log('produtos top15 OK');

    // ── CONDICIONAIS ────────────────────────────────────────────────────────
    const condM = await q(db, `SELECT EXTRACT(YEAR FROM P.DT_PEDIDO) ANO, EXTRACT(MONTH FROM P.DT_PEDIDO) MES,
      CASE WHEN P.ID_STATUS=9 THEN 'Finalizado' WHEN P.ID_STATUS=2 THEN 'Reprovado' ELSE 'Em andamento' END STATUS,
      COUNT(DISTINCT P.ID_PEDIDO) QTD, SUM(COALESCE(T.VLR_TOTAL,0)) VALOR
      FROM TB_PEDIDO_VENDA P LEFT JOIN TB_PEDIDO_VENDA_TOT T ON T.ID_PEDIDO=P.ID_PEDIDO
      WHERE P.ID_STATUS IN (1,2,7,9)
      GROUP BY EXTRACT(YEAR FROM P.DT_PEDIDO), EXTRACT(MONTH FROM P.DT_PEDIDO),
               CASE WHEN P.ID_STATUS=9 THEN 'Finalizado' WHEN P.ID_STATUS=2 THEN 'Reprovado' ELSE 'Em andamento' END
      ORDER BY 1,2,3`);

    const condI = await q(db, `SELECT EXTRACT(YEAR FROM P.DT_PEDIDO) ANO, EXTRACT(MONTH FROM P.DT_PEDIDO) MES,
      CASE WHEN P.ID_STATUS=9 THEN 'Finalizado' WHEN P.ID_STATUS=2 THEN 'Reprovado' ELSE 'Em andamento' END STATUS,
      COUNT(DISTINCT P.ID_PEDIDO) QTD_PEDIDOS, SUM(I.QTD_ITEM) QTD_PECAS, SUM(I.VLR_TOTAL-I.VLR_DESC) VLR_ITENS
      FROM TB_PEDIDO_VENDA P JOIN TB_PED_VENDA_ITEM I ON I.ID_PEDIDO=P.ID_PEDIDO
      WHERE P.ID_STATUS IN (1,2,7,9)
      GROUP BY EXTRACT(YEAR FROM P.DT_PEDIDO), EXTRACT(MONTH FROM P.DT_PEDIDO),
               CASE WHEN P.ID_STATUS=9 THEN 'Finalizado' WHEN P.ID_STATUS=2 THEN 'Reprovado' ELSE 'Em andamento' END
      ORDER BY 1,2,3`);

    const condA = await q(db, `SELECT P.ID_PEDIDO, CAST(CURRENT_DATE-P.DT_PEDIDO AS INTEGER) DIAS, SUM(I.VLR_TOTAL-I.VLR_DESC) VALOR
      FROM TB_PEDIDO_VENDA P JOIN TB_PED_VENDA_ITEM I ON I.ID_PEDIDO=P.ID_PEDIDO
      WHERE P.ID_STATUS IN (1,7) GROUP BY 1,2 ORDER BY 2 DESC`);

    const condSI = await q(db, `SELECT COUNT(*) C FROM TB_PEDIDO_VENDA P
      WHERE P.ID_STATUS IN (1,2,7,9) AND NOT EXISTS (SELECT 1 FROM TB_PED_VENDA_ITEM I WHERE I.ID_PEDIDO=P.ID_PEDIDO)`);

    const condTot = await q(db, `SELECT COUNT(*) C FROM TB_PEDIDO_VENDA WHERE ID_STATUS IN (1,2,7,9)`);
    console.log('condicionais OK');

    // ── ESTOQUE ─────────────────────────────────────────────────────────────
    const skusR = await q(db, `SELECT COUNT(*) C FROM TB_ESTOQUE`);
    const zerosR = await q(db, `SELECT COUNT(*) C FROM TB_ESTOQUE E WHERE NOT EXISTS
      (SELECT 1 FROM TB_EST_IDENTIFICADOR EI JOIN TB_EST_PRODUTO EP ON EP.ID_IDENTIFICADOR=EI.ID_IDENTIFICADOR
       WHERE EI.ID_ESTOQUE=E.ID_ESTOQUE AND EP.QTD_ATUAL>0)`);
    const valsR = await q(db, `SELECT SUM(EP.QTD_ATUAL) PECAS, SUM(EP.QTD_ATUAL*E.PRC_CUSTO) CUSTO, SUM(EP.QTD_ATUAL*E.PRC_VENDA) VENDA
      FROM TB_EST_PRODUTO EP JOIN TB_EST_IDENTIFICADOR EI ON EI.ID_IDENTIFICADOR=EP.ID_IDENTIFICADOR
      JOIN TB_ESTOQUE E ON E.ID_ESTOQUE=EI.ID_ESTOQUE WHERE EP.QTD_ATUAL>0`);
    const movMR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      SUM(I.QTD_ITEM) QTD, SUM(I.VLR_CUSTO) CUSTO
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO='65' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);
    const movGR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      SUM(I.QTD_ITEM) QTD, SUM(I.VLR_CUSTO) CUSTO
      FROM TB_NFVENDA N JOIN TB_NFV_ITEM I ON I.ID_NFVENDA=N.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO='GR' AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);
    const czR = await q(db, `SELECT EXTRACT(YEAR FROM N.DT_EMISSAO) ANO, EXTRACT(MONTH FROM N.DT_EMISSAO) MES,
      SUM(CASE WHEN COALESCE(I.VLR_CUSTO,0)=0 THEN I.QTD_ITEM ELSE 0 END) QTD_SEM_CUSTO,
      SUM(CASE WHEN COALESCE(I.VLR_CUSTO,0)=0 THEN I.VLR_TOTAL-I.VLR_DESC ELSE 0 END) VLR_SEM_CUSTO,
      SUM(I.QTD_ITEM) QTD_TOTAL, SUM(I.VLR_TOTAL-I.VLR_DESC) VLR_TOTAL_VENDA
      FROM TB_NFV_ITEM I JOIN TB_NFVENDA N ON N.ID_NFVENDA=I.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO IN ('65','GR') AND N.DT_EMISSAO>=DATE '${s}' AND N.DT_EMISSAO<DATE '${e}'
      GROUP BY 1,2 ORDER BY 1,2`);
    const sk1R = await q(db, `SELECT COUNT(DISTINCT I.ID_IDENTIFICADOR) C FROM TB_NFV_ITEM I
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=I.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO IN ('65','GR') AND N.DT_EMISSAO>=DATE '${s}' AND COALESCE(I.VLR_CUSTO,0)=0`);
    const sk2R = await q(db, `SELECT COUNT(DISTINCT I.ID_IDENTIFICADOR) C FROM TB_NFV_ITEM I
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=I.ID_NFVENDA
      WHERE N.STATUS='E' AND N.NF_MODELO IN ('65','GR') AND N.DT_EMISSAO>=DATE '${s}'`);
    console.log('estoque OK');

    // ── RECEBER ─────────────────────────────────────────────────────────────
    const recM = await q(db, `SELECT
      CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_EMISSAO) END ANO,
      CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_EMISSAO) END MES,
      COUNT(DISTINCT R.ID_CTAREC) QTD, SUM(R.VLR_CTAREC) EMIT,
      SUM(CASE WHEN R.DT_BAIXA IS NULL THEN R.VLR_CTAREC ELSE 0 END) ABERTO,
      SUM(CASE WHEN R.DT_BAIXA IS NULL AND R.DT_VENCTO<CURRENT_DATE THEN R.VLR_CTAREC ELSE 0 END) VENCIDO,
      SUM(CASE WHEN R.DT_BAIXA IS NOT NULL THEN R.VLR_RECEBIDO ELSE 0 END) RECEBIDO
      FROM V_CONTAS_RECEBER R
      GROUP BY
        CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_EMISSAO) END,
        CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_EMISSAO) END`);
    console.log('receber mensal OK');

    const agingR = await q(db, `SELECT
      CASE WHEN DT_VENCTO>=CURRENT_DATE THEN '0'
        WHEN CURRENT_DATE-DT_VENCTO<=30 THEN '1' WHEN CURRENT_DATE-DT_VENCTO<=60 THEN '2'
        WHEN CURRENT_DATE-DT_VENCTO<=90 THEN '3' WHEN CURRENT_DATE-DT_VENCTO<=180 THEN '4'
        WHEN CURRENT_DATE-DT_VENCTO<=365 THEN '5' ELSE '6' END FAIXA,
      SUM(VLR_CTAREC) VALOR
      FROM V_CONTAS_RECEBER WHERE DT_BAIXA IS NULL
      GROUP BY CASE WHEN DT_VENCTO>=CURRENT_DATE THEN '0'
        WHEN CURRENT_DATE-DT_VENCTO<=30 THEN '1' WHEN CURRENT_DATE-DT_VENCTO<=60 THEN '2'
        WHEN CURRENT_DATE-DT_VENCTO<=90 THEN '3' WHEN CURRENT_DATE-DT_VENCTO<=180 THEN '4'
        WHEN CURRENT_DATE-DT_VENCTO<=365 THEN '5' ELSE '6' END`);
    console.log('aging OK');

    const mpcR = await q(db, `SELECT
      CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_EMISSAO) END ANO,
      CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_EMISSAO) END MES,
      COUNT(DISTINCT R.ID_CTAREC) QTD, SUM(R.VLR_CTAREC) EMIT,
      SUM(CASE WHEN R.DT_BAIXA IS NULL THEN R.VLR_CTAREC ELSE 0 END) ABERTO,
      SUM(CASE WHEN R.DT_BAIXA IS NULL AND R.DT_VENCTO<CURRENT_DATE THEN R.VLR_CTAREC ELSE 0 END) VENCIDO,
      SUM(CASE WHEN R.DT_BAIXA IS NOT NULL THEN R.VLR_RECEBIDO ELSE 0 END) RECEBIDO
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND F.DESCRICAO IN ('Prazo','Cheque')
      GROUP BY
        CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_EMISSAO) END,
        CASE WHEN R.DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_EMISSAO) END`);
    console.log('mensal prazo OK');

    const rvpaR = await q(db, `SELECT
      CASE WHEN R.DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_VENCTO) END ANO,
      CASE WHEN R.DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_VENCTO) END MES,
      COUNT(DISTINCT R.ID_CTAREC) QTD, SUM(R.VLR_CTAREC) DEVIDO,
      SUM(CASE WHEN R.DT_BAIXA IS NULL THEN R.VLR_CTAREC ELSE 0 END) NAO_RECEBIDO
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND F.DESCRICAO IN ('Prazo','Cheque')
      GROUP BY
        CASE WHEN R.DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM R.DT_VENCTO) END,
        CASE WHEN R.DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM R.DT_VENCTO) END`);

    const rvpbR = await q(db, `SELECT EXTRACT(YEAR FROM R.DT_BAIXA) ANO, EXTRACT(MONTH FROM R.DT_BAIXA) MES, SUM(R.VLR_RECEBIDO) REC
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND F.DESCRICAO IN ('Prazo','Cheque') AND R.DT_BAIXA IS NOT NULL AND R.DT_BAIXA>=DATE '${s}'
      GROUP BY 1,2`);
    console.log('vencimento prazo OK');

    const rpfR = await q(db, `SELECT F.DESCRICAO FORMA, SUM(R.VLR_CTAREC) VALOR
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' GROUP BY F.DESCRICAO ORDER BY SUM(R.VLR_CTAREC) DESC`);
    console.log('por forma OK');

    const rvfR = await q(db, `SELECT
      CASE WHEN DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_VENCTO) END VA,
      CASE WHEN DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_VENCTO) END VM,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END EA,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END EM,
      SUM(VLR_CTAREC) DEVIDO, SUM(CASE WHEN DT_BAIXA IS NULL THEN VLR_CTAREC ELSE 0 END) NAO_RECEBIDO
      FROM V_CONTAS_RECEBER
      GROUP BY
        CASE WHEN DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_VENCTO) END,
        CASE WHEN DT_VENCTO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_VENCTO) END,
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END,
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END`);
    console.log('venc todas formas OK');

    const rbpR = await q(db, `SELECT EXTRACT(YEAR FROM R.DT_BAIXA) ANO, EXTRACT(MONTH FROM R.DT_BAIXA) MES,
      SUM(CASE WHEN R.DT_BAIXA<=R.DT_VENCTO THEN R.VLR_RECEBIDO ELSE 0 END) EM_DIA,
      SUM(CASE WHEN R.DT_BAIXA>R.DT_VENCTO THEN R.VLR_RECEBIDO ELSE 0 END) ATRASO, SUM(R.VLR_RECEBIDO) TOTAL
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND F.DESCRICAO='Prazo' AND R.DT_BAIXA IS NOT NULL AND R.DT_BAIXA>=DATE '${s}'
      GROUP BY 1,2 ORDER BY 1,2`);

    const pmrR = await q(db, `SELECT EXTRACT(YEAR FROM R.DT_BAIXA) ANO, EXTRACT(MONTH FROM R.DT_BAIXA) MES,
      SUM(R.VLR_RECEBIDO) TOTAL, SUM((R.DT_BAIXA-R.DT_EMISSAO)*R.VLR_RECEBIDO) SOMA_DIAS
      FROM V_CONTAS_RECEBER R
      JOIN TB_NFVENDA N ON N.ID_NFVENDA=R.ID_NFVENDA
      JOIN TB_NFVENDA_FMAPAGTO_NFCE P ON P.ID_NFVENDA=N.ID_NFVENDA
      JOIN TB_FORMA_PAGTO_NFCE F ON F.ID_FMANFCE=P.ID_FMANFCE
      WHERE N.STATUS='E' AND F.DESCRICAO='Prazo' AND R.DT_BAIXA IS NOT NULL AND R.DT_BAIXA>=DATE '${s}'
        AND R.DT_EMISSAO>=DATE '${s}' AND R.DT_EMISSAO IS NOT NULL
      GROUP BY 1,2 ORDER BY 1,2`);
    console.log('receber PMR OK');

    // ── PAGAR ───────────────────────────────────────────────────────────────
    const pagMR = await q(db, `SELECT
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END ANO,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END MES,
      COUNT(*) QTD, SUM(VLR_CTAPAG) EMIT,
      SUM(CASE WHEN DT_BAIXA IS NULL THEN VLR_CTAPAG ELSE 0 END) ABERTO,
      SUM(CASE WHEN DT_BAIXA IS NULL AND DT_VENCTO<CURRENT_DATE THEN VLR_CTAPAG ELSE 0 END) VENCIDO,
      SUM(CASE WHEN DT_BAIXA IS NOT NULL THEN VLR_PAGTO ELSE 0 END) PAGO
      FROM V_CONTAS_PAGAR WHERE (DESCRICAO_CTA<>'AJUSTES' OR DESCRICAO_CTA IS NULL)
      GROUP BY
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END,
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END
      ORDER BY 1,2`);
    console.log('pagar mensal OK');

    const planoR = await q(db, `SELECT
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END ANO,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END MES,
      COALESCE(DESC_PLA_ORIGEM,'Sem categoria') CATEGORIA, SUM(VLR_CTAPAG) VALOR
      FROM V_CONTAS_PAGAR WHERE (DESCRICAO_CTA<>'AJUSTES' OR DESCRICAO_CTA IS NULL)
      GROUP BY
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END,
        CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END,
        COALESCE(DESC_PLA_ORIGEM,'Sem categoria')
      ORDER BY 1,2`);
    console.log('plano contas OK');

    const detR = await q(db, `SELECT ID_CTAPAG, COALESCE(DOCUMENTO,'') DOC,
      COALESCE(HISTORICO,'') HIST, CAST(DT_EMISSAO AS VARCHAR(10)) DT,
      COALESCE(CAST(DT_VENCTO AS VARCHAR(10)),'') VENC, VLR_CTAPAG VALOR,
      COALESCE(DESC_PLA_ORIGEM,'Sem categoria') CATEGORIA,
      COALESCE(NOME,'') FORNECEDOR,
      CASE WHEN DT_BAIXA IS NULL THEN 0 ELSE 1 END BAIXADO,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(YEAR FROM DT_EMISSAO) END ANO,
      CASE WHEN DT_EMISSAO<DATE '${s}' THEN 0 ELSE EXTRACT(MONTH FROM DT_EMISSAO) END MES
      FROM V_CONTAS_PAGAR
      WHERE DT_EMISSAO IS NOT NULL AND (DESCRICAO_CTA<>'AJUSTES' OR DESCRICAO_CTA IS NULL)
      ORDER BY DT_EMISSAO`);
    console.log('pagar detalhe OK (' + detR.length + ' records)');

    const baixaR = await q(db, `SELECT EXTRACT(YEAR FROM DT_BAIXA) ANO, EXTRACT(MONTH FROM DT_BAIXA) MES,
      SUM(CASE WHEN DT_BAIXA<=DT_VENCTO THEN VLR_PAGTO ELSE 0 END) EM_DIA,
      SUM(CASE WHEN DT_BAIXA>DT_VENCTO THEN VLR_PAGTO ELSE 0 END) ATRASO, SUM(VLR_PAGTO) TOTAL
      FROM V_CONTAS_PAGAR
      WHERE DT_BAIXA IS NOT NULL AND DT_BAIXA>=DATE '${s}' AND DT_BAIXA<DATE '${e}'
        AND (DESCRICAO_CTA<>'AJUSTES' OR DESCRICAO_CTA IS NULL)
      GROUP BY 1,2 ORDER BY 1,2`);

    const pmpPR = await q(db, `SELECT EXTRACT(YEAR FROM DT_BAIXA) ANO, EXTRACT(MONTH FROM DT_BAIXA) MES,
      SUM(VLR_PAGTO) TOTAL, SUM((DT_BAIXA-DT_EMISSAO)*VLR_PAGTO) SOMA_DIAS
      FROM V_CONTAS_PAGAR
      WHERE DT_BAIXA IS NOT NULL AND DT_BAIXA>=DATE '${s}' AND DT_EMISSAO IS NOT NULL
        AND (DESCRICAO_CTA<>'AJUSTES' OR DESCRICAO_CTA IS NULL)
      GROUP BY 1,2 ORDER BY 1,2`);

    const ajR = await q(db, `SELECT COUNT(*) QTD, COALESCE(SUM(VLR_CTAPAG),0) VALOR FROM V_CONTAS_PAGAR WHERE DESCRICAO_CTA='AJUSTES'`);
    console.log('pagar baixa+PMP+ajustes OK');

    // ── CONTAS ──────────────────────────────────────────────────────────────
    const saldoR = await q(db, `SELECT DESCRICAO CONTA,
      SUM(CASE WHEN TIPO='ENTRADAS' THEN VALOR ELSE 0 END) ENTRADAS,
      SUM(CASE WHEN TIPO='SAIDAS' THEN VALOR ELSE 0 END) SAIDAS,
      SUM(CASE WHEN TIPO='ENTRADAS' THEN VALOR ELSE -VALOR END) SALDO
      FROM V_REL_FINAN_BANCOS_CAIXA GROUP BY 1 ORDER BY 4 DESC`);

    const inativosR = await q(db, `SELECT B.DESCRICAO CONTA,
      COALESCE(SUM(CASE WHEN V.TIPO='ENTRADAS' THEN V.VALOR ELSE -V.VALOR END),0) SALDO
      FROM TB_BANCO_CTA B LEFT JOIN V_REL_FINAN_BANCOS_CAIXA V ON V.DESCRICAO=B.DESCRICAO
      WHERE B.STATUS='I' GROUP BY B.DESCRICAO ORDER BY B.DESCRICAO`).catch(() => []);

    const cgR = await q(db, `SELECT EXTRACT(YEAR FROM DT_MOVTO) ANO, EXTRACT(MONTH FROM DT_MOVTO) MES,
      SUM(CASE WHEN TIPO='ENTRADAS' THEN VALOR ELSE -VALOR END) SALDO_MES
      FROM V_REL_FINAN_BANCOS_CAIXA WHERE DESCRICAO='Caixa Geral' GROUP BY 1,2 ORDER BY 1,2`);

    const totR = await q(db, `SELECT EXTRACT(YEAR FROM DT_MOVTO) ANO, EXTRACT(MONTH FROM DT_MOVTO) MES,
      SUM(CASE WHEN TIPO='ENTRADAS' THEN VALOR ELSE -VALOR END) SALDO_MES
      FROM V_REL_FINAN_BANCOS_CAIXA WHERE DESCRICAO<>'AJUSTES' GROUP BY 1,2 ORDER BY 1,2`);

    const acertoR = await q(db, `SELECT DESCRICAO, TIPO, VALOR, DT_MOVTO, HISTORICO
      FROM V_REL_FINAN_BANCOS_CAIXA
      WHERE HISTORICO CONTAINING 'Acerto de Caixa' ORDER BY DT_MOVTO DESC`).catch(() => []);
    console.log('contas OK');

    // ─── ASSEMBLE ────────────────────────────────────────────────────────────
    db.detach();
    console.log('DB detached. Assembling DADOS...');

    // ─ Vendas ─
    const mensalBK = {};
    mensalR.forEach(r => { mensalBK[`${r.ANO}-${r.MES}`] = r; });
    const nfBK = {};
    nfR.forEach(r => { nfBK[`${r.ANO}-${r.MES}`] = r; });
    const mensal = months.map(m => { const r = mensalBK[`${m.ano}-${m.mes}`] || null;
      return { ano: m.ano, mes: m.mes, qtd: r?ri(r.QTD):0, total: r?r2(r.TOTAL):0, desconto: r?r2(r.DESCONTO):0 }; });
    const naoFiscalMensal = months.map(m => { const r = nfBK[`${m.ano}-${m.mes}`] || null;
      return { ano: m.ano, mes: m.mes, qtd: r?ri(r.QTD):0, total: r?r2(r.TOTAL):0 }; });

    const mergedProd = {};
    const prodOrder = [];
    prodR.forEach(r => {
      const k = `${r.ANO}|${r.MES}|${r.NOME}`;
      if (mergedProd[k]) { mergedProd[k].qtd += ri(r.QTD); mergedProd[k].total = r2(mergedProd[k].total + Number(r.TOTAL)); }
      else { mergedProd[k] = { ano: ri(r.ANO), mes: ri(r.MES), nome: String(r.NOME||''), qtd: ri(r.QTD), total: r2(r.TOTAL) }; prodOrder.push(k); }
    });

    const vendas = {
      mensal,
      vendedorasMensal: vendR.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), nome:String(r.NOME||''), qtd:ri(r.QTD), total:r2(r.TOTAL) })),
      produtosMensal: prodOrder.map(k => mergedProd[k]),
      pagamentoMensal: pagR.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), forma:normForma(String(r.FORMA||'')), total:r2(r.TOTAL) })),
      pagamentoNota: 'Inclui vendas fiscais (NFC-e modelo 65) e gerenciais (modelo GR) juntas.',
      naoFiscalNota: 'Vendas exclusivamente gerenciais (sem NFC-e) não entram no detalhe de forma de pagamento acima — são registros internos sem dado de forma de pagamento.',
      fiscalizacaoPorForma: fiscR.map(r => ({ forma:normForma(String(r.FORMA||'')), fiscal:r2(r.FISCAL), gerencial:r2(r.GERENCIAL) })),
      clienteTipoMensal: cltR.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), tipo:String(r.TIPO||'').trim(), total:r2(r.TOTAL) })),
      naoFiscalMensal,
      canceladoMensal: cancR.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), qtd:ri(r.QTD), total:r2(r.TOTAL) })),
      canceladoGerencialMensal: cancGR.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), qtd:ri(r.QTD), total:r2(r.TOTAL) })),
    };

    // ─ Condicionais ─
    const semItemN = condSI[0] ? ri(condSI[0].C) : 0;
    const totN = condTot[0] ? ri(condTot[0].C) : 0;
    const condicionais = {
      mensal: condM.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), status:String(r.STATUS||'').trim(), qtd:ri(r.QTD), valor:r2(r.VALOR) })),
      itensMensal: condI.map(r => ({ ano:ri(r.ANO), mes:ri(r.MES), status:String(r.STATUS||'').trim(), qtdPedidos:ri(r.QTD_PEDIDOS), qtdPecas:ri(r.QTD_PECAS), vlr:r2(r.VLR_ITENS) })),
      abertosHoje: condA.map(r => ({ id:ri(r.ID_PEDIDO), dias:ri(r.DIAS), valor:r2(r.VALOR) })),
      pedidosSemItem: semItemN,
      nota: `Total de ${totN} registros.${semItemN>0?' '+semItemN+' pedido(s) sem item.':''}`,
    };

    // ─ Estoque ─
    const now = new Date();
    const vs = valsR[0] || {};
    const estoque = {
      atual: { skus:ri(skusR[0]&&skusR[0].C), zerado:ri(zerosR[0]&&zerosR[0].C),
        pecas:r2(vs.PECAS), custo:r2(vs.CUSTO), venda:r2(vs.VENDA),
        snapshotDate: `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}` },
      movMensal: months.map(m => { const r = movMR.find(x=>ri(x.ANO)===m.ano&&ri(x.MES)===m.mes)||null;
        return { ano:m.ano, mes:m.mes, qtdPecas:r?ri(r.QTD):0, vlrCusto:r?r2(r.CUSTO):0 }; }),
      movMensalGerencial: months.map(m => { const r = movGR.find(x=>ri(x.ANO)===m.ano&&ri(x.MES)===m.mes)||null;
        return { ano:m.ano, mes:m.mes, qtdPecas:r?ri(r.QTD):0, vlrCusto:r?r2(r.CUSTO):0 }; }),
      custoZeradoMensal: months.map(m => { const r = czR.find(x=>ri(x.ANO)===m.ano&&ri(x.MES)===m.mes)||null;
        return { ano:m.ano, mes:m.mes, qtdSemCusto:r?ri(r.QTD_SEM_CUSTO):0, vlrSemCusto:r?r2(r.VLR_SEM_CUSTO):0, qtdTotal:r?ri(r.QTD_TOTAL):0, vlrTotal:r?r2(r.VLR_TOTAL_VENDA):0 }; }),
      skusVendidosComCustoZerado: ri(sk1R[0]&&sk1R[0].C),
      skusVendidosTotal: ri(sk2R[0]&&sk2R[0].C),
    };

    // ─ Receber ─
    const recLeg = recM.find(r=>ri(r.ANO)===0);
    const recLegado = recLeg ? { qtd:ri(recLeg.QTD), emit:r2(recLeg.EMIT), aberto:r2(recLeg.ABERTO), vencido:r2(recLeg.VENCIDO), recebido:r2(recLeg.RECEBIDO) } : {qtd:0,emit:0,aberto:0,vencido:0,recebido:0};
    const recBK = {}; recM.filter(r=>ri(r.ANO)>0).forEach(r=>{recBK[`${r.ANO}-${r.MES}`]=r;});
    const mpcBK = {}; mpcR.filter(r=>ri(r.ANO)>0).forEach(r=>{mpcBK[`${r.ANO}-${r.MES}`]=r;});
    const rvpaBK = {}; rvpaR.forEach(r=>{rvpaBK[`${r.ANO}-${r.MES}`]=r;});
    const rvpbBK = {}; rvpbR.forEach(r=>{rvpbBK[`${r.ANO}-${r.MES}`]=r;});
    const rbpBK  = {}; rbpR.forEach(r=>{rbpBK[`${r.ANO}-${r.MES}`]=r;});
    const pmrBK  = {}; pmrR.forEach(r=>{pmrBK[`${r.ANO}-${r.MES}`]=r;});

    const vencLeg = rvpaR.find(r=>ri(r.ANO)===0);
    const vencimentoPrazoCheque = months.map(m => {
      const a=rvpaBK[`${m.ano}-${m.mes}`]||null, b=rvpbBK[`${m.ano}-${m.mes}`]||null;
      return { ano:m.ano, mes:m.mes, qtd:a?ri(a.QTD):0, devido:a?r2(a.DEVIDO):0, naoRecebido:a?r2(a.NAO_RECEBIDO):0, recebidoNoMes:b?r2(b.REC):0 };
    });
    if (vencLeg) vencimentoPrazoCheque.unshift({ ano:0, mes:0, qtd:ri(vencLeg.QTD), devido:r2(vencLeg.DEVIDO), naoRecebido:r2(vencLeg.NAO_RECEBIDO), recebidoNoMes:0 });

    const receber = {
      legado: recLegado,
      mensal: months.map(m=>{const r=recBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,qtd:r?ri(r.QTD):0,emit:r?r2(r.EMIT):0,aberto:r?r2(r.ABERTO):0,vencido:r?r2(r.VENCIDO):0,recebido:r?r2(r.RECEBIDO):0};}),
      agingTotalHoje: ['1','2','3','4','5','6'].map(code=>{
        const row=agingR.find(r=>String(r.FAIXA||'').trim()===code);
        return row ? {faixa:AGING_LABELS[code].faixa,valor:r2(row.VALOR),cor:AGING_LABELS[code].cor} : null;
      }).filter(Boolean),
      mensalPrazoCheque: months.map(m=>{const r=mpcBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,qtd:r?ri(r.QTD):0,emit:r?r2(r.EMIT):0,aberto:r?r2(r.ABERTO):0,vencido:r?r2(r.VENCIDO):0,recebido:r?r2(r.RECEBIDO):0};}),
      vencimentoPrazoCheque,
      porFormaPagamento: rpfR.map(r=>{const f=normForma(String(r.FORMA||'')); return {forma:f,valor:r2(r.VALOR),cor:formaColor(f)};}).sort((a,b)=>b.valor-a.valor),
      vencimentoTodasFormas: rvfR.map(r=>({va:ri(r.VA),vm:ri(r.VM),ea:ri(r.EA),em:ri(r.EM),devido:r2(r.DEVIDO),naoRecebido:r2(r.NAO_RECEBIDO)})),
      baixaMensalPrazo: months.map(m=>{const r=rbpBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,emDia:r?r2(r.EM_DIA):0,atraso:r?r2(r.ATRASO):0,total:r?r2(r.TOTAL):0};}),
      pmrMensalPrazo: months.map(m=>{const r=pmrBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,total:r?r2(r.TOTAL):0,somaDias:r?r2(r.SOMA_DIAS):0};}),
    };

    // ─ Pagar ─
    const pagLeg = pagMR.find(r=>ri(r.ANO)===0);
    const pagLegado = pagLeg ? {qtd:ri(pagLeg.QTD),emit:r2(pagLeg.EMIT),aberto:r2(pagLeg.ABERTO),vencido:r2(pagLeg.VENCIDO),pago:r2(pagLeg.PAGO)} : {qtd:0,emit:0,aberto:0,vencido:0,pago:0};
    const pagBK={}; pagMR.filter(r=>ri(r.ANO)>0).forEach(r=>{pagBK[`${r.ANO}-${r.MES}`]=r;});
    const baixaBK={}; baixaR.forEach(r=>{baixaBK[`${r.ANO}-${r.MES}`]=r;});
    const pmpPBK={}; pmpPR.forEach(r=>{pmpPBK[`${r.ANO}-${r.MES}`]=r;});
    const ajQtd=ri(ajR[0]&&ajR[0].QTD), ajVal=r2(ajR[0]&&ajR[0].VALOR);
    const pagar = {
      legado: pagLegado,
      mensal: months.map(m=>{const r=pagBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,qtd:r?ri(r.QTD):0,emit:r?r2(r.EMIT):0,aberto:r?r2(r.ABERTO):0,vencido:r?r2(r.VENCIDO):0,pago:r?r2(r.PAGO):0};}),
      planoContasMensal: planoR.map(r=>({ano:ri(r.ANO),mes:ri(r.MES),categoria:String(r.CATEGORIA||''),valor:r2(r.VALOR)})),
      classificacao: CLASSIFICACAO,
      detalhe: detR.map(r=>({id:ri(r.ID_CTAPAG),doc:String(r.DOC||''),hist:String(r.HIST||''),dt:String(r.DT||''),venc:String(r.VENC||''),valor:r2(r.VALOR),categoria:String(r.CATEGORIA||''),fornecedor:String(r.FORNECEDOR||''),baixado:!!ri(r.BAIXADO),ano:ri(r.ANO),mes:ri(r.MES)})),
      baixaMensal: months.map(m=>{const r=baixaBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,emDia:r?r2(r.EM_DIA):0,atraso:r?r2(r.ATRASO):0,total:r?r2(r.TOTAL):0};}),
      pmpMensal: months.map(m=>{const r=pmpPBK[`${m.ano}-${m.mes}`]||null; return {ano:m.ano,mes:m.mes,total:r?r2(r.TOTAL):0,somaDias:r?r2(r.SOMA_DIAS):0};}),
    };

    // ─ Contas ─
    const inativasSet = new Set(inativosR.map(r=>String(r.CONTA||'')));
    const saldoPorConta = saldoR.filter(r=>!inativasSet.has(String(r.CONTA||''))).map(r=>({conta:String(r.CONTA||''),entradas:r2(r.ENTRADAS),saidas:r2(r.SAIDAS),saldo:r2(r.SALDO)}));
    const cgBK={}; cgR.forEach(r=>{cgBK[`${r.ANO}-${r.MES}`]=r;});
    const totBK={}; totR.forEach(r=>{totBK[`${r.ANO}-${r.MES}`]=r;});
    const allMonthKeys=new Set([...cgR,...totR].map(r=>`${r.ANO}-${r.MES}`));
    const sortedMK=[...allMonthKeys].sort().map(k=>{const [a,m]=k.split('-'); return {ano:parseInt(a),mes:parseInt(m)};});
    let acertoCaixaAchado={valor:0,data:null,hora:null,texto:null};
    if (acertoR.length) {
      const la=acertoR[0]; const val=r2(la.VALOR);
      let dtStr='',hora='';
      if(la.DT_MOVTO){const d=new Date(la.DT_MOVTO); dtStr=`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; hora=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
      acertoCaixaAchado={valor:val,data:dtStr,hora,texto:`No dia ${dtStr}${hora?' às '+hora:''}, foi registrado um "Acerto de Caixa" de ${val.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} na conta ${String(la.DESCRICAO||'')}. Confirmar com o cliente o que aconteceu com esse valor.`};
    }
    const inativasNomes=inativosR.map(r=>r.CONTA).join(', ');
    const contas = {
      nota: `Saldo calculado como entradas menos saídas no sistema — pode não bater com extrato bancário real (saldo anterior ao histórico não incluído).${inativasNomes?' Contas inativas ocultadas: '+inativasNomes+'.':''} "AJUSTES" incluída propositalmente — alto volume indica lançamentos genéricos.`,
      saldoPorConta,
      contasInativasOcultas: inativosR.map(r=>({conta:String(r.CONTA||''),saldo:r2(r.SALDO)})),
      caixaGeralMensal: sortedMK.map(m=>({ano:m.ano,mes:m.mes,saldoMes:cgBK[`${m.ano}-${m.mes}`]?r2(cgBK[`${m.ano}-${m.mes}`].SALDO_MES):0})),
      totalMensal: sortedMK.map(m=>({ano:m.ano,mes:m.mes,saldoMes:totBK[`${m.ano}-${m.mes}`]?r2(totBK[`${m.ano}-${m.mes}`].SALDO_MES):0})),
      ajustesAchado: {qtd:ajQtd,valor:ajVal,texto:ajQtd>0?`"AJUSTES" usado em ${ajQtd} lançamentos (${ajVal.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}).`:null},
      acertoCaixaAchado,
    };

    console.log('DADOS assembled OK');
    return { vendas, condicionais, estoque, receber, pagar, contas };

  } catch(err) {
    try { db.detach(); } catch(e) {}
    throw err;
  }
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
app.get('/api/browse', async (req, res) => {
  // Electron: usa dialog nativo (aparece na frente da janela do app)
  if (process.versions.electron) {
    try {
      const { dialog, BrowserWindow } = require('electron');
      const win = BrowserWindow.getAllWindows()[0] || null;
      const result = await dialog.showOpenDialog(win, {
        title: 'Selecionar banco CLIPP',
        filters: [
          { name: 'Firebird Database', extensions: ['fdb', 'FDB'] },
          { name: 'Todos os arquivos', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      return res.json({ path: result.canceled ? '' : (result.filePaths[0] || '') });
    } catch(e) { return res.json({ path: '' }); }
  }

  // Fallback Node.js: PowerShell OpenFileDialog
  const os = require('os');
  const fs = require('fs');
  const tmp = path.join(os.tmpdir(), 'clipp_browse.ps1');
  fs.writeFileSync(tmp, [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Filter = 'Firebird (*.fdb)|*.fdb|Todos os arquivos (*.*)|*.*'",
    "$d.Title = 'Selecionar banco CLIPP'",
    "if (\$d.ShowDialog() -eq 'OK') { Write-Output \$d.FileName }",
  ].join('\r\n'), 'utf8');
  try {
    const result = execSync(`powershell -NoProfile -Sta -File "${tmp}"`, {encoding:'utf8', timeout:60000}).trim();
    res.json({ path: result || '' });
  } catch(e) { res.json({ path: '' }); }
});

app.post('/api/connect', (req, res) => {
  const { database, host, port, user, password, fbVersion } = req.body;
  const isV5 = String(fbVersion||'').startsWith('5');
  const cfg = {
    host:     host||'127.0.0.1',
    port:     parseInt(port)||3050,
    database: database||dbConfig.database,
    user:     user||'SYSDBA',
    password: password||'masterkey',
    lowercase_keys: false,
    charset:  'UTF8',
    pageSize: 4096,
    // Firebird 3+/5 pode usar SRP; se falhar, o cliente tenta Legacy_Auth também
    ...(isV5 ? { wireCrypt: 'Enabled' } : {}),
  };
  Firebird.attach(cfg, (err, db) => {
    if (err) {
      // Para FB5: sugere mensagem mais clara se for erro de autenticação
      const hint = isV5 && (err.message||'').match(/password|auth|login/i)
        ? ' (Dica: habilite Legacy_Auth no firebird.conf do servidor)'
        : '';
      return res.json({ ok:false, error: err.message + hint });
    }
    db.query('SELECT COUNT(*) C FROM TB_NFVENDA', (err2, rows) => {
      db.detach();
      if (err2) return res.json({ ok:false, error:err2.message });
      dbConfig = cfg;
      res.json({ ok:true, nfCount: rows&&rows[0] ? ri(rows[0].C) : 0, fbVersion: fbVersion||'2.5' });
    });
  });
});

app.get('/api/dados', async (req, res) => {
  try {
    const { startDate, endDate } = getDateRange();
    const months = generateMonths(startDate, endDate);
    console.log(`Loading data: ${startDate} → ${endDate} (${months.length} months)`);
    const dados = await buildDados(startDate, endDate, months);
    res.json({ ok:true, dados });
  } catch(e) {
    console.error('DADOS ERROR:', e.message);
    res.json({ ok:false, error:e.message });
  }
});

// ─── Verificação de atualização ──────────────────────────────────────────────
// Aponte para o repositório GitHub onde os releases serão publicados
const UPDATE_REPO = 'junin1737/analisemt';

app.get('/api/check-update', (req, res) => {
  const https = require('https');
  const pkg   = require('./package.json');
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${UPDATE_REPO}/releases/latest`,
    headers: { 'User-Agent': 'Painel-CLIPP' },
  };
  const request = https.get(options, (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => {
      try {
        const release = JSON.parse(data);
        if (release.message) { // repo não encontrado ou sem releases
          return res.json({ ok: true, hasUpdate: false, current: pkg.version, latest: pkg.version });
        }
        const latest  = (release.tag_name || '').replace(/^v/, '');
        const hasUpdate = latest && latest !== pkg.version &&
          latest.localeCompare(pkg.version, undefined, { numeric: true }) > 0;
        res.json({ ok: true, hasUpdate, current: pkg.version, latest, url: release.html_url || '' });
      } catch(e) { res.json({ ok: false, error: e.message }); }
    });
  });
  request.on('error', e => res.json({ ok: false, error: e.message }));
  request.setTimeout(8000, () => { request.destroy(); res.json({ ok: false, error: 'timeout' }); });
});

const PORT = 5050;
app.listen(PORT, () => console.log(`Painel CLIPP em http://localhost:${PORT}`));
