/**
 * 基金净值自动追踪 + 纳指定投脚本
 * 每天22:30运行（GitHub Actions），抓取天天基金最新净值更新 data.json
 *
 * 定投：广发纳指100联接C 每天10块
 * 追踪：按份额×最新净值计算所有基金市值
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../data.json');

// 天天基金实时估值API
const FUND_API = code => `https://fundgz.1234567.com.cn/js/${code}.js`;

// 定投配置：基金代码 → 每日金额、扣款账户、记账信息
const DAILY_INVEST = {
  '006479': { amount: 10, account: 'bankCard', item: '纳指定投', category: '基金' },
};

async function fetchFundData(code) {
  const url = FUND_API(code);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const match = text.match(/\{.*\}/);
  if (!match) throw new Error(`无法解析 ${code} 的响应数据`);
  return JSON.parse(match[0]);
}

function getChinaDate() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    month: cst.getUTCMonth() + 1,
    day: cst.getUTCDate(),
    str: `${cst.getUTCMonth() + 1}/${cst.getUTCDate()}`,
  };
}

function fmtISODate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const results = [];
  const today = getChinaDate();

  // 周末不执行定投
  const dow = new Date().getDay(); // 0=周日 6=周六
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
      const info = await fetchFundData(fund.code);
      const nav = parseFloat(info.dwjz);
      const estNav = parseFloat(info.gsz);
      const currentNav = isNaN(nav) ? estNav : nav;

      if (isNaN(currentNav) || currentNav <= 0) {
        throw new Error(`净值数据异常: dwjz=${info.dwjz}, gsz=${info.gsz}`);
      }

      // ---- 首次运行：先确保有份额数据 ----
      if (!fund.shares && fund.shares !== 0) {
        fund.shares = Math.round((fund.value / currentNav) * 10000) / 10000;
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;
        fund.change = 0;
        results.push({
          name: fund.name,
          nav: currentNav,
          shares: fund.shares,
          value: fund.value,
          status: '📌 首次追踪，已推算份额',
        });
      }

      // ---- 定投处理 ----
      const invest = DAILY_INVEST[fund.code];
      if (invest && !investDone) {
        const newShares = invest.amount / currentNav;
        fund.shares = Math.round((fund.shares + newShares) * 10000) / 10000;

        // 扣款
        if (invest.account === 'bankCard') {
          data.bankCard = Math.max(0, data.bankCard - invest.amount);
        }

        // 记账
        data.expense.push({
          date: today.str,
          item: invest.item,
          category: invest.category,
          amount: invest.amount,
        });

        results.push({
          name: fund.name,
          action: '💰 定投+' + invest.amount,
          newShares: fund.shares,
        });
      }

      // ---- 市值更新 ----
      if (results.find(r => r.name === fund.name && r.status?.startsWith('📌'))) {
        // 首次追踪已处理，跳过
      } else {
        const oldValue = fund.value;
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;

        // 排除定投部分算出纯涨跌
        const investAmt = (invest && !investDone) ? invest.amount : 0;
        const pureChange = fund.value - oldValue - investAmt;
        fund.change = Math.round(pureChange * 100) / 100;
        results.push({
          name: fund.name,
          nav: currentNav,
          shares: fund.shares,
          oldValue,
          newValue: fund.value,
          investAdded: investAmt || undefined,
          pureChange: Math.round(pureChange * 100) / 100,
          status: pureChange >= 0 ? '📈' : '📉',
        });
      }
    } catch (e) {
      results.push({ name: fund.name, code: fund.code, status: `❌ ${e.message}` });
    }
  }

  data.updated = fmtISODate(new Date());
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  console.log('=== 草山账本 基金自动更新 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(`更新时间: ${data.updated}`);
  if (investDone) console.log('💤 今日定投已执行过，跳过');
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
