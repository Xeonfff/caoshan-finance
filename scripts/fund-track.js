/**
 * 基金净值自动追踪 + 纳指定投脚本
 * 每天22:30运行（GitHub Actions），抓取天天基金官方确认净值更新 data.json
 *
 * 定投：广发纳指100联接C 每天10块
 * 追踪：按份额×最新净值计算市值，对比 lastNav 算涨跌
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../data.json');

// 天天基金官方历史净值API（需 Referer）
const CONFIRMED_NAV_API = code =>
  `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=1&pageSize=3`;

// 实时估算API（QDII基金当天无确认净值时回退用）
const ESTIMATE_API = code => `https://fundgz.1234567.com.cn/js/${code}.js`;

const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Referer': 'https://fund.eastmoney.com/',
};

const DAILY_INVEST = {
  '006479': { amount: 10, account: 'bankCard', item: '纳指定投', category: '基金' },
};

/** 抓取官方确认净值列表 */
async function fetchConfirmedNAV(code) {
  const url = CONFIRMED_NAV_API(code);
  const res = await fetch(url, { headers: API_HEADERS });
  const text = await res.text();
  const match = text.match(/jQuery\((\{.*\})\)/);
  if (!match) throw new Error(`无法解析 ${code} 的确认净值数据`);
  const body = JSON.parse(match[1]);
  const list = body?.Data?.LSJZList;
  if (!list || list.length === 0) throw new Error(`${code} 无净值记录`);
  return list.map(r => ({
    date: r.FSRQ,
    nav: parseFloat(r.DWJZ),
    changePct: parseFloat(r.JZZZL) || 0,
  }));
}

/** 抓取实时估算净值（QDII回退用） */
async function fetchEstimateNAV(code) {
  const url = ESTIMATE_API(code);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const match = text.match(/\{.*\}/);
  if (!match) throw new Error(`无法解析 ${code} 的估算数据`);
  const data = JSON.parse(match[0]);
  const nav = parseFloat(data.gsz);
  if (isNaN(nav) || nav <= 0) throw new Error(`${code} 估算净值异常: ${data.gsz}`);
  return { nav, isEstimate: true };
}

function getChinaDate() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    month: cst.getUTCMonth() + 1,
    day: cst.getUTCDate(),
    str: `${cst.getUTCMonth() + 1}/${cst.getUTCDate()}`,
    iso: fmtISODate(cst),
  };
}

function fmtISODate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const results = [];
  const today = getChinaDate();

  const dow = new Date().getDay();
  const isWeekend = dow === 0 || dow === 6;
  const investDone = isWeekend || data.expense.some(
    e => e.date === today.str && e.item === '纳指定投'
  );

  for (const fund of data.funds) {
    if (!fund.code || fund.code === '--') {
      results.push({ name: fund.name, status: '⏭️ 跳过（无基金代码）' });
      continue;
    }

    try {
      // 1) 尝试取官方确认净值
      let currentNav, navDate, isEstimate = false;
      let prevNav = null; // 上一个交易日确认净值（算涨跌用）
      try {
        const navList = await fetchConfirmedNAV(fund.code);
        const latest = navList[0];
        const prev = navList[1];
        currentNav = latest.nav;
        navDate = latest.date;
        prevNav = prev?.nav || null;

        // 如果最新确认净值不是今天的（QDII），用估算净值补当天数据
        if (navDate !== today.iso) {
          try {
            const est = await fetchEstimateNAV(fund.code);
            currentNav = est.nav;
            navDate = today.iso; // 用估算时标记为今天
            isEstimate = true;
          } catch {
            // 估算也拿不到就保持确认净值
          }
        }
      } catch {
        // 2) 确认净值完全拿不到，回退到估算
        try {
          const est = await fetchEstimateNAV(fund.code);
          currentNav = est.nav;
          navDate = today.iso;
          isEstimate = true;
        } catch (e2) {
          throw new Error(`所有数据源均失败: ${e2.message}`);
        }
      }

      if (isNaN(currentNav) || currentNav <= 0) {
        throw new Error(`净值异常: ${currentNav}`);
      }

      const invest = DAILY_INVEST[fund.code];
      const isFirstRun = !fund.shares && fund.shares !== 0;

      // ---- 首次运行：初始化份额 + lastNav ----
      if (isFirstRun) {
        fund.shares = Math.round((fund.value / currentNav) * 10000) / 10000;
        // 如果是估算净值，首次先用 dwjz 初始化
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;
        fund.lastNav = currentNav;
        fund.lastNavDate = navDate;
        fund.change = 0;
        results.push({
          name: fund.name,
          nav: currentNav,
          navDate,
          shares: fund.shares,
          value: fund.value,
          isEstimate,
          status: '📌 首次追踪',
        });
        continue;
      }

      // ---- 净值有更新才算涨跌 ----
      let pureChange = 0;
      if (navDate !== fund.lastNavDate && fund.lastNav) {
        pureChange = Math.round((fund.shares * (currentNav - fund.lastNav)) * 100) / 100;
      }

      const oldValue = fund.value;

      // ---- 定投处理 ----
      if (invest && !investDone) {
        const newShares = invest.amount / currentNav;
        const roundedShares = Math.round(newShares * 10000) / 10000;
        fund.shares = Math.round((fund.shares + roundedShares) * 10000) / 10000;

        if (invest.account === 'bankCard') {
          data.bankCard = Math.max(0, data.bankCard - invest.amount);
        }

        data.expense.push({
          date: today.str,
          item: invest.item,
          category: invest.category,
          amount: invest.amount,
        });
      }

      // ---- 更新市值 + lastNav ----
      fund.value = Math.round(fund.shares * currentNav * 100) / 100;
      fund.lastNav = currentNav;
      fund.lastNavDate = navDate;
      if (pureChange !== 0) fund.change = pureChange;

      results.push({
        name: fund.name,
        nav: currentNav,
        navDate,
        shares: fund.shares,
        oldValue,
        newValue: fund.value,
        pureChange,
        investAdded: invest && !investDone ? invest.amount : undefined,
        isEstimate,
        status: pureChange > 0 ? '📈' : pureChange < 0 ? '📉' : '➡️',
      });
    } catch (e) {
      results.push({ name: fund.name, code: fund.code, status: `❌ ${e.message}` });
    }
  }

  data.updated = fmtISODate(new Date());
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  console.log('=== 草山账本 基金自动更新 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(`更新时间: ${data.updated}`);
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
