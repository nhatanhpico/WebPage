import { defineConfig } from 'vite'

// base './' → chạy được ở bất kỳ đường dẫn nào (username.github.io/<repo>/ hoặc domain riêng)
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
})
