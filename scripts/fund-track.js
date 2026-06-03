/**
 * 基金净值自动追踪 + 纳指定投脚本
 * 每天22:30运行（GitHub Actions），抓取天天基金最新净值更新 data.json
 *
 * 定投：广发纳指100联接C 每天10块
 * 追踪：按份额×最新净值计算市值，对比 lastNav 算涨跌
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../data.json');

const FUND_API = code => `https://fundgz.1234567.com.cn/js/${code}.js`;

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
      const info = await fetchFundData(fund.code);
      const dwjz = parseFloat(info.dwjz);
      const gsz = parseFloat(info.gsz);
      // 用实时估算净值（gsz），没有则用上期确认净值（dwjz）
      const currentNav = !isNaN(gsz) && gsz > 0 ? gsz : dwjz;

      if (isNaN(currentNav) || currentNav <= 0) {
        throw new Error(`净值数据异常: dwjz=${info.dwjz}, gsz=${info.gsz}`);
      }

      const invest = DAILY_INVEST[fund.code];
      const isFirstRun = !fund.shares && fund.shares !== 0;

      // ---- 首次运行：初始化份额 + lastNav ----
      if (isFirstRun) {
        fund.shares = Math.round((fund.value / currentNav) * 10000) / 10000;
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;
        fund.lastNav = currentNav;
        fund.change = 0;
        results.push({
          name: fund.name,
          nav: currentNav,
          shares: fund.shares,
          value: fund.value,
          lastNav: currentNav,
          status: '📌 首次追踪',
        });
        continue; // 首次不执行定投也不重复计算
      }

      // ---- 计算纯净值涨跌（对比 lastNav） ----
      const oldValue = fund.value;
      const pureChange = Math.round((fund.shares * (currentNav - (fund.lastNav || currentNav))) * 100) / 100;

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
      fund.change = pureChange;

      results.push({
        name: fund.name,
        nav: currentNav,
        shares: fund.shares,
        oldValue,
        newValue: fund.value,
        investAdded: invest && !investDone ? invest.amount : undefined,
        pureChange,
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
