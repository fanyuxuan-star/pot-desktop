import { Button } from '@nextui-org/react';
import { MdClose, MdExpandLess, MdExpandMore } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import React, { memo, useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import Database from 'tauri-plugin-sql-api';

import { info } from 'tauri-plugin-log-api';

// 一次最多加载的记录条数
const MAX_ITEMS = 50;
// 折叠时最多显示的内容行数；短内容不会被限制，正常展示即可
const COLLAPSED_LINES = 3;
// 超过这个长度才需要「展开/收起」
const SHORT_TEXT_LENGTH = 48;

function needsExpand(text) {
    const value = String(text ?? '');
    return value.length > SHORT_TEXT_LENGTH || value.split('\n').length > COLLAPSED_LINES;
}

function formatTime(timestamp, t) {
    const value = Number(timestamp);
    if (!value) {
        return '';
    }
    const diff = Date.now() - value;
    if (diff < 60 * 1000) {
        return t('translate.history.just_now');
    }
    if (diff < 60 * 60 * 1000) {
        return t('translate.history.minutes_ago', { count: Math.floor(diff / 60000) });
    }
    if (diff < 24 * 60 * 60 * 1000) {
        return t('translate.history.hours_ago', { count: Math.floor(diff / 3600000) });
    }
    const date = new Date(value);
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 单独 memo：展开/收起只重渲染被点的那一条，不带着 50 条一起重排
const HistoryItem = memo(function HistoryItem({ item, expanded, onToggle, t }) {
    const expandable = needsExpand(item.text);

    const handleKeyDown = (event) => {
        if (!expandable) {
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle(item.id);
        }
    };

    return (
        <div
            role={expandable ? 'button' : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? expanded : undefined}
            title={expandable ? t(expanded ? 'translate.history.collapse' : 'translate.history.expand') : undefined}
            className={`mt-1.5 rounded-small bg-default-100/70 px-2 py-1.5 transition-colors outline-none ${
                expandable
                    ? 'cursor-pointer hover:bg-default-200/70 focus-visible:ring-2 focus-visible:ring-primary'
                    : ''
            }`}
            onClick={expandable ? () => onToggle(item.id) : undefined}
            onKeyDown={handleKeyDown}
        >
            <p
                className={`text-small break-words whitespace-pre-wrap ${
                    expanded ? 'max-h-[45vh] overflow-y-auto' : 'line-clamp-3'
                }`}
            >
                {item.text}
            </p>
            <p
                className={`text-tiny text-default-500 mt-1 break-words whitespace-pre-wrap ${
                    expanded ? 'max-h-[30vh] overflow-y-auto' : 'line-clamp-2'
                }`}
            >
                {item.result}
            </p>
            <div className='flex items-center justify-between mt-1'>
                <span className='text-tiny text-default-400'>{formatTime(item.timestamp, t)}</span>
                {expandable && (
                    <span className='text-tiny text-primary flex items-center gap-0.5'>
                        {t(expanded ? 'translate.history.collapse' : 'translate.history.expand')}
                        {expanded ? <MdExpandLess className='text-[14px]' /> : <MdExpandMore className='text-[14px]' />}
                    </span>
                )}
            </div>
        </div>
    );
});

export default function HistoryPanel({ onClose }) {
    const { t } = useTranslation();
    const [items, setItems] = useState([]);
    const [expandedMap, setExpandedMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async () => {
        setFailed(false);
        try {
            const db = await Database.load('sqlite:history.db');
            const rows = await db.select(`SELECT * FROM history ORDER BY id DESC LIMIT ${MAX_ITEMS}`);
            setItems(Array.isArray(rows) ? rows : []);
        } catch (error) {
            info(`Load history failed: ${error}`);
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        // 翻译完成后 target area 会广播这个事件，面板随之刷新
        const unlisten = listen('history_updated', load);
        return () => {
            unlisten.then((fn) => fn());
        };
    }, [load]);

    // Esc 优先关面板（捕获阶段拦截，否则会触发全局的“关闭窗口”）
    useEffect(() => {
        const handler = (event) => {
            if (event.key === 'Escape' && onClose) {
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [onClose]);

    const toggleItem = useCallback((id) => {
        setExpandedMap((previous) => ({ ...previous, [id]: !previous[id] }));
    }, []);

    return (
        <div className='w-[264px] shrink-0 h-full flex flex-col rounded-medium border-1 border-default-100 bg-content2/40'>
            <div className='flex items-center justify-between pl-3 pr-1 pt-1'>
                <span className='text-small font-medium text-foreground/80'>{t('translate.history.title')}</span>
                <div className='flex items-center gap-1'>
                    {items.length > 0 && <span className='text-tiny text-default-400'>{items.length}</span>}
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        aria-label={t('translate.close')}
                        className='bg-transparent'
                        onPress={onClose}
                    >
                        <MdClose className='text-[16px] text-default-400' />
                    </Button>
                </div>
            </div>
            <div className='flex-1 overflow-y-auto px-2 pb-2'>
                {failed && (
                    <div className='mt-6 px-3 text-center'>
                        <p className='text-tiny text-danger'>{t('translate.history.error')}</p>
                        <Button
                            size='sm'
                            variant='light'
                            className='mt-1 text-tiny'
                            onPress={load}
                        >
                            {t('translate.retry')}
                        </Button>
                    </div>
                )}
                {!failed && !loading && items.length === 0 && (
                    <p className='text-tiny text-default-400 text-center mt-6 px-3'>{t('translate.history.empty')}</p>
                )}
                {items.map((item) => (
                    <HistoryItem
                        key={item.id}
                        item={item}
                        expanded={!!expandedMap[item.id]}
                        onToggle={toggleItem}
                        t={t}
                    />
                ))}
            </div>
        </div>
    );
}
