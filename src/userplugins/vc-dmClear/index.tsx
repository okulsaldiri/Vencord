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

interface DmClearSettings {
    messageCount: string;
    deleteSleep: number;
    fetchSleep: number;
    enabled: boolean;
}

const DEFAULT_SETTINGS: DmClearSettings = {
    messageCount: "50",
    deleteSleep: 500,
    fetchSleep: 400,
    enabled: true
};

const SETTINGS_KEY = "vc-dmClear-settings";
const LOGS_KEY = "vc-dmClear-logs";

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

function DmClearModal(props: any & { channel: TargetChannel; }) {

    const { channel } = props;
    const me = UserStore.getCurrentUser();

    const [settings, setSettings] = React.useState<DmClearSettings>(DEFAULT_SETTINGS);
    const [logs, setLogs] = React.useState<string[]>([]);
    const [running, setRunning] = React.useState(false);
    const [progress, setProgress] = React.useState(0);
    const [settingsLoaded, setSettingsLoaded] = React.useState(false);
    const stopRef = React.useRef(false);

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
            } catch (e) {
                console.error("Failed to load settings:", e);
            } finally {
                setSettingsLoaded(true);
            }
        }
        loadSettings();
    }, []);

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

    function stopDelete() {
        stopRef.current = true;
        globalStop = true;
        notify("🛑 İşlem durduruldu");
        addLog("🛑 Stopped by user");
    }

    async function startDelete() {
        stopRef.current = false;
        globalStop = false;

        const limit = Math.min(5000, Math.max(1, parseInt(settings.messageCount) || 0));
        if (!limit) return;

        setRunning(true);
        setProgress(0);
        addLog(`Started deleting ${limit} messages`);

        let deleted = 0;
        let beforeId: string | undefined;
        const seen = new Set<string>();

        let safety = 0;

        try {
            while (deleted < limit && safety < 1000 && !stopRef.current && !globalStop) {
                safety++;

                let messages = getMessages(channel.id);

                if (!messages.length) {
                    const ok = await fetchOlder(channel.id, beforeId);
                    if (!ok) break;

                    await sleep(settings.fetchSleep);
                    messages = getMessages(channel.id);
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

                    const ok = await fetchOlder(channel.id, beforeId);
                    if (!ok) break;

                    await sleep(settings.fetchSleep);
                    continue;
                }

                for (const msg of mine) {
                    if (deleted >= limit || stopRef.current || globalStop) break;

                    seen.add(msg.id);

                    const ok = await deleteMessage(
                        channel.id,
                        msg.id
                    );

                    if (ok) {
                        deleted++;
                        const remaining = limit - deleted;
                        setProgress((deleted / limit) * 100);

                        const text = `Mesaj Silindi : ${deleted}/${limit} / Kalan : ${remaining}`;

                        addLog(text);
                        notify(text);
                    } else {
                        addLog(`Failed: ${msg.id}`);
                    }

                    await sleep(settings.deleteSleep);
                }

                beforeId = messages[messages.length - 1]?.id;
            }

            notify(`Tamamlandı: ${deleted} mesaj silindi`);
            addLog(`Done. Deleted ${deleted}`);
            setProgress(100);
        } finally {
            setRunning(false);
        }
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
                    onClick={stopDelete}
                    color={Button.Colors.RED}
                >
                    Stop
                </Button>

                <Button disabled={running} onClick={props.onClose}>
                    Close
                </Button>

                <Button disabled={running} onClick={startDelete}>
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
