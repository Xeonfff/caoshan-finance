/**
 * 基金净值自动追踪脚本
 * 每天早上7:00运行（GitHub Actions），获取最新净值更新 data.json
 *
 * 追踪逻辑：
 * - 已知份额（shares）的基金：新市值 = 份额 × 最新净值
 * - 未知份额的基金：首次运行时用当前市值反推份额，之后同上
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../data.json');

// 天天基金实时估值API
// 返回格式: jsonpgz({"fundcode":"...","name":"...","jzrq":"2026-06-02","dwjz":"2.6102","gsz":"2.6102","gztime":"2026-06-03 15:00","gszzl":"0.00"})
const FUND_API = code => `https://fundgz.1234567.com.cn/js/${code}.js`;

async function fetchFundData(code) {
  const url = FUND_API(code);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const match = text.match(/\{.*\}/);
  if (!match) throw new Error(`无法解析 ${code} 的响应数据`);
  return JSON.parse(match[0]);
}

function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  // 读取当前数据
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const results = [];

  for (const fund of data.funds) {
    // 跳过没有基金代码的（无法自动追踪）
    if (!fund.code || fund.code === '--') {
      results.push({ name: fund.name, status: '⏭️ 跳过（无基金代码）' });
      continue;
    }

    try {
      const info = await fetchFundData(fund.code);
      const nav = parseFloat(info.dwjz);      // 最新单位净值
      const estNav = parseFloat(info.gsz);     // 实时估算净值
      const currentNav = isNaN(nav) ? estNav : nav;

      if (isNaN(currentNav) || currentNav <= 0) {
        throw new Error(`净值数据异常: dwjz=${info.dwjz}, gsz=${info.gsz}`);
      }

      if (!fund.shares) {
        // 首次运行：用当前市值反推份额
        fund.shares = Math.round((fund.value / currentNav) * 4) / 4; // 保留4位小数
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;
        results.push({
          name: fund.name,
          nav: currentNav,
          shares: fund.shares,
          value: fund.value,
          status: '📌 首次追踪，已推算份额',
        });
      } else {
        // 已有份额：直接用份额算新市值
        const oldValue = fund.value;
        fund.value = Math.round(fund.shares * currentNav * 100) / 100;
        const change = fund.value - oldValue;
        results.push({
          name: fund.name,
          nav: currentNav,
          shares: fund.shares,
          oldValue,
          newValue: fund.value,
          change: Math.round(change * 100) / 100,
          status: change >= 0 ? '📈' : '📉',
        });
      }
    } catch (e) {
      results.push({ name: fund.name, code: fund.code, status: `❌ ${e.message}` });
    }
  }

  // 更新时间
  data.updated = fmtDate(new Date());

  // 写回文件
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // 输出结果（会被 GitHub Actions 捕获）
  console.log('=== 基金净值更新结果 ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(`更新时间: ${data.updated}`);
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
