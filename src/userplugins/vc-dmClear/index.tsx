/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { get, set } from "@api/DataStore";
import { Card } from "@components/Card";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    Menu,
    MessageStore,
    Modal,
    React,
    Slider,
    TextInput,
    UserStore
} from "@webpack/common";

const ChannelStore = findByPropsLazy("getChannel");
const SelectedChannelStore = findByPropsLazy("getChannelId");

const MessageDeleter = findByPropsLazy("deleteMessage");
const MessageFetcher = findByPropsLazy("fetchMessages");
const Toasts = findByPropsLazy("showToast") ?? findByPropsLazy("createToast");

let globalStop = false;
let currentOperation: {
    channelId: string;
    running: boolean;
    deleted: number;
    limit: number;
    progress: number;
    beforeId?: string;
    seen: Set<string>;
} | null = null;

interface DmClearSettings {
    messageCount: string;
    deleteSleep: number;
    fetchSleep: number;
    enabled: boolean;
}

interface OperationState {
    channelId: string;
    running: boolean;
    deleted: number;
    limit: number;
    progress: number;
    beforeId?: string;
    seen: string[];
}

const DEFAULT_SETTINGS: DmClearSettings = {
    messageCount: "50",
    deleteSleep: 500,
    fetchSleep: 400,
    enabled: true
};

const SETTINGS_KEY = "vc-dmClear-settings";
const LOGS_KEY = "vc-dmClear-logs";
const OPERATION_KEY = "vc-dmClear-operation";

const MENU_IDS = [
    "channel-context",
    "thread-context",
    "user-context",
    "private-channel-context",
    "private-channel-user-context"
];

type TargetChannel = {
    id: string;
    name?: string;
};

const sleep = (ms: number) =>
    new Promise<void>(r => setTimeout(r, ms));

function notify(msg: string) {
    try {
        if (!msg || !msg.trim()) return;
        const text = `viez ${msg}`;

        if (Toasts?.showToast) {
            Toasts.showToast(text);
        } else if (Toasts?.createToast && Toasts?.show) {
            Toasts.show(Toasts.createToast(text, 0));
        }
    } catch { }
}

function getMessages(channelId: string): any[] {
    try {
        const store = MessageStore.getMessages(channelId);
        if (!store) return [];

        if (typeof store.toArray === "function") return store.toArray();
        if (store?._map) return Array.from(store._map.values());
        if (store?._array) return store._array;

        return [];
    } catch {
        return [];
    }
}

async function fetchOlder(channelId: string, before?: string) {
    try {
        const fetch = MessageFetcher?.fetchMessages ?? MessageFetcher;
        if (!fetch) return false;

        await fetch({
            channelId,
            before,
            limit: 100
        });

        return true;
    } catch {
        return false;
    }
}

async function deleteMessage(channelId: string, messageId: string) {
    try {
        await Promise.resolve(
            MessageDeleter.deleteMessage(channelId, messageId, false)
        );
        return true;
    } catch {
        try {
            await Promise.resolve(
                MessageDeleter.deleteMessage(channelId, messageId)
            );
            return true;
        } catch {
            return false;
        }
    }
}

function getChannel(args: any[]): TargetChannel | null {
    for (const arg of args) {
        if (arg?.channel?.id) return arg.channel;
        if (arg?.id && typeof arg.id === "string") return arg;
    }

    try {
        const id = SelectedChannelStore.getChannelId?.();
        if (!id) return null;
        return ChannelStore.getChannel(id);
    } catch {
        return null;
    }
}

async function addGlobalLog(msg: string) {
    try {
        const savedLogs = await get<string[]>(LOGS_KEY) || [];
        const newLogs = [...savedLogs.slice(-99), msg];
        await set(LOGS_KEY, newLogs);
    } catch { }
}

async function updateOperationState(state: OperationState | null) {
    try {
        await set(OPERATION_KEY, state);
    } catch { }
}

async function runDeletion(channelId: string, limit: number, deleteSleep: number, fetchSleep: number) {
    const me = UserStore.getCurrentUser();
    if (!me) return;

    let deleted = 0;
    let beforeId: string | undefined;
    const seen = new Set<string>();

    // Check if resuming existing operation
    const savedOperation = await get<OperationState>(OPERATION_KEY);
    if (savedOperation && savedOperation.running && savedOperation.channelId === channelId) {
        deleted = savedOperation.deleted;
        beforeId = savedOperation.beforeId;
        savedOperation.seen.forEach(id => seen.add(id));
        await addGlobalLog(`Resuming from ${deleted}/${limit} deleted`);
    } else {
        await addGlobalLog(`Started deleting ${limit} messages`);
    }

    currentOperation = {
        channelId,
        running: true,
        deleted,
        limit,
        progress: (deleted / limit) * 100,
        beforeId,
        seen
    };

    await updateOperationState({
        channelId,
        running: true,
        deleted,
        limit,
        progress: (deleted / limit) * 100,
        beforeId,
        seen: Array.from(seen)
    });

    let safety = 0;

    try {
        while (deleted < limit && safety < 1000 && !globalStop) {
            safety++;

            let messages = getMessages(channelId);

            if (!messages.length) {
                const ok = await fetchOlder(channelId, beforeId);
                if (!ok) break;

                await sleep(fetchSleep);
                messages = getMessages(channelId);
            }

            const mine = messages
                .filter(
                    m =>
                        m?.author?.id === me?.id &&
                        !seen.has(m.id) &&
                        m?.type === 0
                )
                .sort((a, b) =>
                    BigInt(b.id) > BigInt(a.id) ? 1 : -1
                );

            if (!mine.length) {
                beforeId = messages[messages.length - 1]?.id;

                const ok = await fetchOlder(channelId, beforeId);
                if (!ok) break;

                await sleep(fetchSleep);
                continue;
            }

            for (const msg of mine) {
                if (deleted >= limit || globalStop) break;

                seen.add(msg.id);

                const ok = await deleteMessage(
                    channelId,
                    msg.id
                );

                if (ok) {
                    deleted++;
                    const remaining = limit - deleted;

                    const text = `Mesaj Silindi : ${deleted}/${limit} / Kalan : ${remaining}`;
                    await addGlobalLog(text);
                    notify(text);

                    // Update current operation state
                    currentOperation.deleted = deleted;
                    currentOperation.progress = (deleted / limit) * 100;
                    currentOperation.beforeId = beforeId;

                    // Persist operation state every 10 deletions
                    if (deleted % 10 === 0) {
                        await updateOperationState({
                            channelId,
                            running: true,
                            deleted,
                            limit,
                            progress: (deleted / limit) * 100,
                            beforeId,
                            seen: Array.from(seen)
                        });
                    }
                } else {
                    await addGlobalLog(`Failed: ${msg.id}`);
                }

                await sleep(deleteSleep);
            }

            beforeId = messages[messages.length - 1]?.id;
        }

        notify(`Tamamlandı: ${deleted} mesaj silindi`);
        await addGlobalLog(`Done. Deleted ${deleted}`);
        await updateOperationState(null);
    } finally {
        if (currentOperation) {
            currentOperation.running = false;
        }
    }
}

async function startGlobalDeletion(channelId: string, settings: DmClearSettings) {
    globalStop = false;
    const limit = Math.min(5000, Math.max(1, parseInt(settings.messageCount) || 0));
    if (!limit) return;

    await runDeletion(channelId, limit, settings.deleteSleep, settings.fetchSleep);
}

async function stopGlobalDeletion() {
    globalStop = true;
    notify("🛑 İşlem durduruldu");
    await addGlobalLog("🛑 Stopped by user");

    if (currentOperation) {
        currentOperation.running = false;
        await updateOperationState({
            channelId: currentOperation.channelId,
            running: false,
            deleted: currentOperation.deleted,
            limit: currentOperation.limit,
            progress: currentOperation.progress,
            beforeId: currentOperation.beforeId,
            seen: Array.from(currentOperation.seen)
        });
    }
}

function DmClearModal(props: any & { channel: TargetChannel; }) {

    const { channel } = props;
    const me = UserStore.getCurrentUser();

    const [settings, setSettings] = React.useState<DmClearSettings>(DEFAULT_SETTINGS);
    const [logs, setLogs] = React.useState<string[]>([]);
    const [running, setRunning] = React.useState(false);
    const [progress, setProgress] = React.useState(0);
    const [deletedCount, setDeletedCount] = React.useState(0);
    const [settingsLoaded, setSettingsLoaded] = React.useState(false);
    const pollIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

    // Load settings on mount
    React.useEffect(() => {
        async function loadSettings() {
            try {
                const saved = await get<DmClearSettings>(SETTINGS_KEY);
                if (saved) {
                    setSettings(saved);
                }
                const savedLogs = await get<string[]>(LOGS_KEY);
                if (savedLogs) {
                    setLogs(savedLogs);
                }
                const savedOperation = await get<OperationState>(OPERATION_KEY);
                if (savedOperation && savedOperation.running && savedOperation.channelId === channel.id) {
                    setRunning(true);
                    setDeletedCount(savedOperation.deleted);
                    setProgress(savedOperation.progress);
                    addLog(`Resumed operation: ${savedOperation.deleted}/${savedOperation.limit} deleted`);
                } else if (savedOperation && !savedOperation.running) {
                    // Clear old completed operation state
                    set(OPERATION_KEY, null);
                }
            } catch (e) {
                console.error("Failed to load settings:", e);
            } finally {
                setSettingsLoaded(true);
            }
        }
        loadSettings();
    }, [channel.id]);

    // Poll for operation state updates
    React.useEffect(() => {
        pollIntervalRef.current = setInterval(async () => {
            const savedOperation = await get<OperationState>(OPERATION_KEY);
            if (savedOperation && savedOperation.channelId === channel.id) {
                setRunning(savedOperation.running);
                setDeletedCount(savedOperation.deleted);
                setProgress(savedOperation.progress);

                // Refresh logs
                const currentLogs = await get<string[]>(LOGS_KEY);
                if (currentLogs) {
                    setLogs(currentLogs);
                }
            } else if (!savedOperation && running) {
                // Operation was cleared
                setRunning(false);
            }
        }, 500);

        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
        };
    }, [channel.id, running]);

    // Save settings when they change
    React.useEffect(() => {
        set(SETTINGS_KEY, settings);
    }, [settings]);

    // Save logs when they change
    React.useEffect(() => {
        if (logs.length > 0) {
            set(LOGS_KEY, logs.slice(-100)); // Keep last 100 logs
        }
    }, [logs]);

    const addLog = (msg: string) =>
        setLogs(prev => [...prev.slice(-99), msg]);

    async function handleStartDelete() {
        if (currentOperation && currentOperation.running && currentOperation.channelId === channel.id) {
            // Already running
            return;
        }
        await startGlobalDeletion(channel.id, settings);
    }

    async function handleStopDelete() {
        await stopGlobalDeletion();
    }

    return (
        <Modal
            {...props}
            title="Bulk Delete My Messages"
        >
            <div style={{ width: "400px", padding: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
                {/* Settings Card */}
                <Card variant="normal" defaultPadding>
                    <div style={{ marginBottom: "8px" }}>
                        <label style={{ display: "block", marginBottom: "4px", fontWeight: 600, color: "var(--header-primary)" }}>
                            Message Count
                        </label>
                        <TextInput
                            value={settings.messageCount}
                            onChange={v => setSettings(s => ({ ...s, messageCount: v }))}
                            disabled={running}
                            placeholder="50"
                        />
                    </div>

                    {settingsLoaded && (
                        <>
                            <div style={{ marginBottom: "8px" }}>
                                <label style={{ display: "block", marginBottom: "4px", fontWeight: 600, color: "var(--header-primary)" }}>
                                    Delete Sleep (ms): {Math.round(settings.deleteSleep)}ms
                                </label>
                                <Slider
                                    initialValue={Math.round(settings.deleteSleep)}
                                    minValue={100}
                                    maxValue={3000}
                                    markers={[100, 500, 1000, 1500, 2000, 2500, 3000]}
                                    onValueChange={v => setSettings(s => ({ ...s, deleteSleep: Math.round(v) }))}
                                    onValueRender={v => `${Math.round(v)}ms`}
                                    disabled={running}
                                    stickToMarkers={false}
                                />
                            </div>

                            <div style={{ marginBottom: "4px" }}>
                                <label style={{ display: "block", marginBottom: "4px", fontWeight: 600, color: "var(--header-primary)" }}>
                                    Fetch Sleep (ms): {Math.round(settings.fetchSleep)}ms
                                </label>
                                <Slider
                                    initialValue={Math.round(settings.fetchSleep)}
                                    minValue={100}
                                    maxValue={2000}
                                    markers={[100, 400, 800, 1200, 1600, 2000]}
                                    onValueChange={v => setSettings(s => ({ ...s, fetchSleep: Math.round(v) }))}
                                    onValueRender={v => `${Math.round(v)}ms`}
                                    disabled={running}
                                    stickToMarkers={false}
                                />
                            </div>
                        </>
                    )}
                </Card>

                {/* Progress Card */}
                {running && (
                    <Card variant="info" defaultPadding>
                        <div style={{ marginBottom: "4px", fontWeight: 600, color: "var(--header-primary)" }}>
                            Progress: {progress.toFixed(1)}%
                        </div>
                        <div style={{
                            width: "100%",
                            height: "6px",
                            background: "var(--background-modifier-selected)",
                            borderRadius: "4px",
                            overflow: "hidden"
                        }}>
                            <div style={{
                                width: `${progress}%`,
                                height: "100%",
                                background: "var(--brand-experiment)",
                                transition: "width 0.3s ease"
                            }} />
                        </div>
                    </Card>
                )}

                {/* Logs Card */}
                <Card variant="normal" defaultPadding>
                    <label style={{ display: "block", marginBottom: "4px", fontWeight: 600, color: "var(--header-primary)" }}>
                        Activity Log
                    </label>
                    <textarea
                        readOnly
                        value={logs.join("\n")}
                        style={{
                            width: "100%",
                            height: 80,
                            background: "var(--background-secondary)",
                            color: "var(--text-normal)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "4px",
                            fontFamily: "monospace",
                            fontSize: "11px",
                            padding: "6px"
                        }}
                    />
                </Card>
            </div>

            <div style={{ padding: "8px", display: "flex", justifyContent: "flex-end", gap: "8px", borderTop: "1px solid var(--border-subtle)" }}>
                <Button
                    disabled={!running}
                    onClick={handleStopDelete}
                    color={Button.Colors.RED}
                >
                    Stop
                </Button>

                <Button onClick={props.onClose}>
                    Close
                </Button>

                <Button disabled={running} onClick={handleStartDelete}>
                    Delete
                </Button>
            </div>
        </Modal>
    );
}

function openDmClear(channel: TargetChannel) {
    requestAnimationFrame(() => {
        openModal(props => (
            <DmClearModal {...props} channel={channel} />
        ));
    });
}

function patchMenu(children: any[], ...args: any[]) {
    if (!Array.isArray(children)) return;

    const channel = getChannel(args);
    if (!channel) return;

    children.push(
        <Menu.MenuGroup key="dmclear">
            <Menu.MenuItem
                id="dmclear-delete"
                label="Bulk Delete My Messages"
                action={() => openDmClear(channel)}
            />
        </Menu.MenuGroup>
    );
}

export default definePlugin({
    name: "DmClear",
    description: "Bulk deletes your messages in DMs",
    authors: [Devs.sikilirim],

    start() {
        // Clear logs on plugin start (Discord restart)
        set(LOGS_KEY, []);
        // Clear any stale operation state
        set(OPERATION_KEY, null);

        for (const id of MENU_IDS) {
            addContextMenuPatch(id, patchMenu);
        }
    },

    stop() {
        for (const id of MENU_IDS) {
            removeContextMenuPatch(id, patchMenu);
        }
    }
});
