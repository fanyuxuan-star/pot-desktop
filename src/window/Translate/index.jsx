import { readDir, BaseDirectory, readTextFile, exists } from '@tauri-apps/api/fs';
import { DragDropContext, Draggable, Droppable } from 'react-beautiful-dnd';
import { appWindow, currentMonitor, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { Spacer, Button, Tooltip } from '@nextui-org/react';
import { AiFillCloseCircle } from 'react-icons/ai';
import React, { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { BsPinFill } from 'react-icons/bs';
import { MdHistory } from 'react-icons/md';
import { useTranslation } from 'react-i18next';

import HistoryPanel from './components/HistoryPanel';
import LanguageArea from './components/LanguageArea';
import SourceArea from './components/SourceArea';
import TargetArea from './components/TargetArea';
import { osType } from '../../utils/env';
import { useConfig } from '../../hooks';
import { store } from '../../utils/store';
import { info } from 'tauri-plugin-log-api';

// 历史面板宽度（与 HistoryPanel 的 w-[264px] 保持一致）
const HISTORY_PANEL_WIDTH = 264;
const MIN_WINDOW_WIDTH = 300;

let blurTimeout = null;
let resizeTimeout = null;
let moveTimeout = null;

const listenBlur = () => {
    return listen('tauri://blur', () => {
        if (appWindow.label === 'translate') {
            if (blurTimeout) {
                clearTimeout(blurTimeout);
            }
            info('Blur');
            // 100ms后关闭窗口，因为在 windows 下拖动窗口时会先切换成 blur 再立即切换成 focus
            // 如果直接关闭将导致窗口无法拖动
            blurTimeout = setTimeout(async () => {
                info('Confirm Blur');
                await appWindow.close();
            }, 100);
        }
    });
};

let unlisten = listenBlur();
// 取消 blur 监听
const unlistenBlur = () => {
    unlisten.then((f) => {
        f();
    });
};

// 监听 focus 事件取消 blurTimeout 时间之内的关闭窗口
void listen('tauri://focus', () => {
    info('Focus');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});
// 监听 move 事件取消 blurTimeout 时间之内的关闭窗口
void listen('tauri://move', () => {
    info('Move');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});

export default function Translate() {
    const [closeOnBlur] = useConfig('translate_close_on_blur', true);
    const [alwaysOnTop] = useConfig('translate_always_on_top', false);
    const [windowPosition] = useConfig('translate_window_position', 'mouse');
    const [rememberWindowSize] = useConfig('translate_remember_window_size', false);
    const [translateServiceInstanceList, setTranslateServiceInstanceList] = useConfig('translate_service_list', [
        'deepl',
        'bing',
        'lingva',
        'yandex',
        'google',
        'ecdict',
    ]);
    const [recognizeServiceInstanceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [ttsServiceInstanceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [collectionServiceInstanceList] = useConfig('collection_service_list', []);
    const [hideLanguage] = useConfig('hide_language', false);
    const [pined, setPined] = useState(false);
    const [historyOpen, setHistoryOpen] = useConfig('translate_history_open', false);
    const historyBaseWidth = useRef(null);
    const { t } = useTranslation();
    const [pluginList, setPluginList] = useState(null);
    const [serviceInstanceConfigMap, setServiceInstanceConfigMap] = useState(null);
    const reorder = (list, startIndex, endIndex) => {
        const result = Array.from(list);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return result;
    };

    const onDragEnd = async (result) => {
        if (!result.destination) return;
        const items = reorder(translateServiceInstanceList, result.source.index, result.destination.index);
        setTranslateServiceInstanceList(items);
    };
    // 是否自动关闭窗口
    useEffect(() => {
        if (closeOnBlur !== null && !closeOnBlur) {
            unlistenBlur();
        }
    }, [closeOnBlur]);
    // 是否默认置顶
    useEffect(() => {
        if (alwaysOnTop !== null && alwaysOnTop) {
            appWindow.setAlwaysOnTop(true);
            unlistenBlur();
            setPined(true);
        }
    }, [alwaysOnTop]);
    // 保存窗口位置
    useEffect(() => {
        if (windowPosition !== null && windowPosition === 'pre_state') {
            const unlistenMove = listen('tauri://move', async () => {
                if (moveTimeout) {
                    clearTimeout(moveTimeout);
                }
                moveTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let position = await appWindow.outerPosition();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        position = position.toLogical(factor);
                        await store.set('translate_window_position_x', parseInt(position.x));
                        await store.set('translate_window_position_y', parseInt(position.y));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                unlistenMove.then((f) => {
                    f();
                });
            };
        }
    }, [windowPosition]);
    // 保存窗口大小
    useEffect(() => {
        if (rememberWindowSize !== null && rememberWindowSize) {
            const unlistenResize = listen('tauri://resize', async () => {
                if (resizeTimeout) {
                    clearTimeout(resizeTimeout);
                }
                resizeTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let size = await appWindow.outerSize();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        size = size.toLogical(factor);
                        await store.set('translate_window_height', parseInt(size.height));
                        await store.set('translate_window_width', parseInt(size.width));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                unlistenResize.then((f) => {
                    f();
                });
            };
        }
    }, [rememberWindowSize]);

    const loadPluginList = async () => {
        const serviceTypeList = ['translate', 'tts', 'recognize', 'collection'];
        let temp = {};
        for (const serviceType of serviceTypeList) {
            temp[serviceType] = {};
            if (await exists(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig })) {
                const plugins = await readDir(`plugins/${serviceType}`, { dir: BaseDirectory.AppConfig });
                for (const plugin of plugins) {
                    const infoStr = await readTextFile(`plugins/${serviceType}/${plugin.name}/info.json`, {
                        dir: BaseDirectory.AppConfig,
                    });
                    let pluginInfo = JSON.parse(infoStr);
                    if ('icon' in pluginInfo) {
                        const appConfigDirPath = await appConfigDir();
                        const iconPath = await join(
                            appConfigDirPath,
                            `/plugins/${serviceType}/${plugin.name}/${pluginInfo.icon}`
                        );
                        pluginInfo.icon = convertFileSrc(iconPath);
                    }
                    temp[serviceType][plugin.name] = pluginInfo;
                }
            }
        }
        setPluginList({ ...temp });
    };

    useEffect(() => {
        loadPluginList();
        if (!unlisten) {
            unlisten = listen('reload_plugin_list', loadPluginList);
        }
    }, []);

    const loadServiceInstanceConfigMap = async () => {
        const config = {};
        for (const serviceInstanceKey of translateServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of recognizeServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of ttsServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        for (const serviceInstanceKey of collectionServiceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        setServiceInstanceConfigMap({ ...config });
    };
    useEffect(() => {
        if (
            translateServiceInstanceList !== null &&
            recognizeServiceInstanceList !== null &&
            ttsServiceInstanceList !== null &&
            collectionServiceInstanceList !== null
        ) {
            loadServiceInstanceConfigMap();
        }
    }, [
        translateServiceInstanceList,
        recognizeServiceInstanceList,
        ttsServiceInstanceList,
        collectionServiceInstanceList,
    ]);

    // 打开/关闭历史面板：同时扩宽窗口，并把宽度写回配置，
    // 这样 Rust 下次划词重建窗口尺寸时不会把面板挤回去。
    const toggleHistoryPanel = async () => {
        const next = !historyOpen;
        try {
            if (appWindow.label === 'translate') {
                const factor = (await appWindow.scaleFactor?.()) || 1;
                const size = await appWindow.outerSize();
                const width = Math.round(size.width / factor);
                const height = Math.round(size.height / factor);

                let targetWidth;
                if (next) {
                    historyBaseWidth.current = width;
                    const monitor = await currentMonitor().catch(() => null);
                    const monitorWidth = monitor?.size?.width
                        ? Math.round(monitor.size.width / (monitor.scaleFactor || 1))
                        : width + HISTORY_PANEL_WIDTH;
                    targetWidth = Math.min(width + HISTORY_PANEL_WIDTH, Math.max(monitorWidth - 24, MIN_WINDOW_WIDTH));
                } else {
                    targetWidth = historyBaseWidth.current ?? Math.max(width - HISTORY_PANEL_WIDTH, MIN_WINDOW_WIDTH);
                    historyBaseWidth.current = null;
                }

                if (targetWidth !== width) {
                    await appWindow.setSize(new LogicalSize(targetWidth, height));
                }

                // 窗口贴近屏幕右边缘时向左挪一点，避免展开后超出屏幕
                if (next) {
                    const monitor = await currentMonitor().catch(() => null);
                    const position = await appWindow.outerPosition();
                    if (monitor?.size?.width && position) {
                        const monitorRight = monitor.position.x + monitor.size.width;
                        const overflow = position.x + targetWidth * factor - monitorRight;
                        if (overflow > 0) {
                            await appWindow.setPosition(
                                new PhysicalPosition(Math.max(monitor.position.x, position.x - overflow), position.y)
                            );
                        }
                    }
                }

                await store.set('translate_window_width', targetWidth);
                await store.save();
            }
        } catch (error) {
            info(`Toggle history panel failed: ${error}`);
        }
        setHistoryOpen(next);
    };

    return (
        pluginList && (
            <div
                className={`bg-background h-screen w-screen ${
                    osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
                }`}
            >
                <div
                    className='fixed top-[5px] left-[5px] right-[5px] h-[30px]'
                    data-tauri-drag-region='true'
                />
                <div className='h-[35px] w-full flex justify-between'>
                    <div className='flex'>
                        <Tooltip
                            content={pined ? t('translate.unpin') : t('translate.pin')}
                            placement='bottom'
                            delay={400}
                            closeDelay={0}
                        >
                            <Button
                                isIconOnly
                                size='sm'
                                variant='flat'
                                disableAnimation
                                aria-label={pined ? t('translate.unpin') : t('translate.pin')}
                                className='my-auto bg-transparent'
                                onPress={() => {
                                    if (pined) {
                                        if (closeOnBlur) {
                                            unlisten = listenBlur();
                                        }
                                        appWindow.setAlwaysOnTop(false);
                                    } else {
                                        unlistenBlur();
                                        appWindow.setAlwaysOnTop(true);
                                    }
                                    setPined(!pined);
                                }}
                            >
                                <BsPinFill className={`text-[20px] ${pined ? 'text-primary' : 'text-default-400'}`} />
                            </Button>
                        </Tooltip>
                        <Tooltip
                            content={t('translate.history.title')}
                            placement='bottom'
                            delay={400}
                            closeDelay={0}
                        >
                            <Button
                                isIconOnly
                                size='sm'
                                variant='flat'
                                disableAnimation
                                aria-label={t('translate.history.title')}
                                className='my-auto bg-transparent'
                                onPress={toggleHistoryPanel}
                            >
                                <MdHistory
                                    className={`text-[20px] ${historyOpen ? 'text-primary' : 'text-default-400'}`}
                                />
                            </Button>
                        </Tooltip>
                    </div>
                    <Tooltip
                        content={t('translate.close')}
                        placement='bottom'
                        delay={400}
                        closeDelay={0}
                    >
                        <Button
                            isIconOnly
                            size='sm'
                            variant='flat'
                            disableAnimation
                            aria-label={t('translate.close')}
                            className={`my-auto ${osType === 'Darwin' && 'hidden'} bg-transparent`}
                            onPress={() => {
                                void appWindow.close();
                            }}
                        >
                            <AiFillCloseCircle className='text-[20px] text-default-400' />
                        </Button>
                    </Tooltip>
                </div>
                <div
                    className={`${
                        osType === 'Linux' ? 'h-[calc(100vh-37px)]' : 'h-[calc(100vh-35px)]'
                    } px-[8px] flex gap-2`}
                >
                    <div className='flex-1 min-w-0 h-full overflow-y-auto'>
                        <div>
                            {serviceInstanceConfigMap !== null && (
                                <SourceArea
                                    pluginList={pluginList}
                                    serviceInstanceConfigMap={serviceInstanceConfigMap}
                                />
                            )}
                        </div>
                        <div className={`${hideLanguage ? 'hidden' : 'sticky top-0 z-10 bg-background'}`}>
                            <LanguageArea />
                            <Spacer y={2} />
                        </div>
                        <DragDropContext onDragEnd={onDragEnd}>
                            <Droppable
                                droppableId='droppable'
                                direction='vertical'
                            >
                                {(provided) => (
                                    <div
                                        ref={provided.innerRef}
                                        {...provided.droppableProps}
                                    >
                                        {translateServiceInstanceList !== null &&
                                            serviceInstanceConfigMap !== null &&
                                            translateServiceInstanceList.map((serviceInstanceKey, index) => {
                                                const config = serviceInstanceConfigMap[serviceInstanceKey] ?? {};
                                                const enable = config['enable'] ?? true;

                                                return enable ? (
                                                    <Draggable
                                                        key={serviceInstanceKey}
                                                        draggableId={serviceInstanceKey}
                                                        index={index}
                                                    >
                                                        {(provided) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                            >
                                                                <TargetArea
                                                                    {...provided.dragHandleProps}
                                                                    index={index}
                                                                    name={serviceInstanceKey}
                                                                    translateServiceInstanceList={
                                                                        translateServiceInstanceList
                                                                    }
                                                                    pluginList={pluginList}
                                                                    serviceInstanceConfigMap={serviceInstanceConfigMap}
                                                                />
                                                                <Spacer y={2} />
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                ) : (
                                                    <></>
                                                );
                                            })}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>
                    </div>
                    {historyOpen && <HistoryPanel onClose={toggleHistoryPanel} />}
                </div>
            </div>
        )
    );
}
