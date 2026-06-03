# 草山账本 💰

自动生成财务仪表盘，GitHub Pages 手机随时看。

## 部署步骤

1. **新建仓库**
```bash
gh repo create caoshan-finance --public --clone
```

2. **把文件放进去**
```bash
cd caoshan-finance
# 把 index.html 和 .github/workflows/deploy.yml 放进来
git add .
git commit -m "init"
git push
```

3. **开 GitHub Pages**
   - Settings → Pages → Source: **GitHub Actions**

4. **更新数据**
   - 修改 `data.json` 里的数字
   - 提交推送 → Actions 自动重新部署
   - 手机刷新就能看到更新

## 目录结构
```
├── index.html        # 仪表盘页面
├── data.json         # 账本数据
└── .github/workflows/deploy.yml  # 自动部署
```
