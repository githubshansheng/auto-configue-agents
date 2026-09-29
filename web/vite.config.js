import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 产物直接输出到 Electron 静态目录 app/renderer（与 main.js 的 distDir、build.files 对齐）。
    // outDir 位于 root 之外，vite 默认不清空该目录，必须显式 emptyOutDir。
    outDir: '../app/renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
})
