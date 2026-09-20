import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 监听 0.0.0.0 而不是 localhost：手机连同一个 WiFi 才能打开开发服务器，
    // 这是「浏览器假装手机」这条路能走通的前提。
    host: true,
    // Vite 默认只认 localhost 和 IP，Host 头对不上就回 403。
    // 内网穿透进来的域名（xxx.trycloudflare.com）正撞在这条上。
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // 开发期前端在 5173、中继在 8080，靠代理把 /ws 转过去。
      // 这样前端代码里永远只写 location.host，不用区分开发/生产环境。
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
