import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 监听 0.0.0.0 而不是 localhost：手机连同一个 WiFi 才能打开开发服务器
    host: true,
    proxy: {
      // 开发期前端在 5173、daemon 在 8080，靠代理把 /ws 转过去。
      // 这样前端代码里永远只写 location.host，不用区分开发/生产环境。
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
