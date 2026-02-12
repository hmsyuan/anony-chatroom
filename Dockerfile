# 使用輕量版 Node 映像檔
FROM node:18-alpine

# 設定工作目錄
WORKDIR /app

# 複製檔案
COPY package.json server.js ./
COPY public ./public

# Cloud Run 預設 Port 為 8080
ENV PORT=8080

# 啟動
CMD ["npm", "start"]
