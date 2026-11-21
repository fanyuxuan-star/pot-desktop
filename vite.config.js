import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'path';

// 浏览器预览模式（`pnpm dev:web`）：把 Tauri 相关模块替换成本地 mock，
// 这样不带 Rust/WebView 也能在浏览器里调 UI。正常 tauri dev/build 不受影响。
const previewAlias = [
    { find: /^@tauri-apps\/api(\/.*)?$/, replacement: resolve(__dirname, 'src/dev/mock-tauri.js') },
    { find: /^tauri-plugin-[\w-]+-api$/, replacement: resolve(__dirname, 'src/dev/mock-tauri.js') },
];

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => ({
    plugins: [react()],
    resolve: {
        alias: mode === 'preview' ? previewAlias : [],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
    },
    // to make use of `TAURI_DEBUG` and other env variables
    // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
        rollupOptions: {
            input: {
                index: resolve(__dirname, 'index.html'),
                daemon: resolve(__dirname, 'daemon.html'),
            },
        },
        // Tauri supports es2021
        target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari11',
        // don't minify for debug builds
        minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
        // produce sourcemaps for debug builds
        sourcemap: !!process.env.TAURI_DEBUG,
    },
}));
