import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { appWindow } from '@tauri-apps/api/window';
import { NextUIProvider } from '@nextui-org/react';
import ReactDOM from 'react-dom/client';
import React from 'react';

import { initStore } from './utils/store';
import { initEnv } from './utils/env';
import App from './App';

if (import.meta.env.PROD) {
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });
}

// 浏览器预览模式：右下角提示当前预览的窗口，避免和真实 Tauri 运行混淆
if (import.meta.env.MODE === 'preview') {
    const label = new URLSearchParams(location.search).get('window') || 'config';
    const badge = document.createElement('div');
    badge.textContent = `预览模式 · window=${label}`;
    badge.style.cssText =
        'position:fixed;right:8px;bottom:8px;z-index:9999;padding:4px 8px;border-radius:6px;' +
        'background:rgba(0,0,0,.65);color:#fff;font-size:12px;line-height:1.4;pointer-events:none';
    document.body.appendChild(badge);
}

initStore().then(async () => {
    await initEnv();
    const rootElement = document.getElementById('root');
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <NextUIProvider>
            <NextThemesProvider attribute='class'>
                <App />
            </NextThemesProvider>
        </NextUIProvider>
    );
});
