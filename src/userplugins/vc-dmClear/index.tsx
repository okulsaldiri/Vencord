/*
 * Vencord UserPlugin - DmClear (Filtered + 3s Delay + Notify)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { openModal, Modals } from "@utils/modal";

import {
    Button,
    Forms,
    Menu,
    MessageStore,
    React,
    TextInput,
    UserStore
} from "@webpack/common";

const ChannelStore = findByPropsLazy("getChannel");
const SelectedChannelStore = findByPropsLazy("getChannelId");

const MessageDeleter = findByPropsLazy("deleteMessage");
const MessageFetcher = findByPropsLazy("fetchMessages");
const Toasts = findByPropsLazy("showToast") ?? findByPropsLazy("createToast");

let globalStop = false;

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
    } catch {}
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

function DmClearModal(props: any & { channel: TargetChannel }) {
    if (!Modals?.ModalRoot) return null;

    const { channel } = props;
    const me = UserStore.getCurrentUser();

    const [count, setCount] = React.useState("50");
    const [logs, setLogs] = React.useState<string[]>([]);
    const [running, setRunning] = React.useState(false);
    const stopRef = React.useRef(false);

    const addLog = (msg: string) =>
        setLogs(prev => [...prev, msg]);

    function stopDelete() {
        stopRef.current = true;
        globalStop = true;
        notify("🛑 İşlem durduruldu");
        addLog("🛑 Stopped by user");
    }

    async function startDelete() {
        stopRef.current = false;
        globalStop = false;

        const limit = Math.min(5000, Math.max(1, parseInt(count) || 0));
        if (!limit) return;

        setRunning(true);
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

                    await sleep(900);
                    messages = getMessages(channel.id);
                }

                const mine = messages
                    .filter(
                        m =>
                            m?.author?.id === me?.id &&
                            !seen.has(m.id) &&
                            m?.type === 0 // 🔥 SADECE NORMAL MESAJLAR
                    )
                    .sort((a, b) =>
                        BigInt(b.id) > BigInt(a.id) ? 1 : -1
                    );

                if (!mine.length) {
                    beforeId = messages[messages.length - 1]?.id;

                    const ok = await fetchOlder(channel.id, beforeId);
                    if (!ok) break;

                    await sleep(400);
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

                        const text = `Mesaj Silindi : ${deleted}/${limit} / Kalan : ${remaining}`;

                        addLog(text);
                        notify(text);
                    } else {
                        addLog(`Failed: ${msg.id}`);
                    }

                    await sleep(500); // 🔥 3 SANİYE
                }

                beforeId = messages[messages.length - 1]?.id;
            }

            notify(`Tamamlandı: ${deleted} mesaj silindi`);
            addLog(`Done. Deleted ${deleted}`);
        } finally {
            setRunning(false);
        }
    }

    return (
        <Modals.ModalRoot {...props}>
            <Modals.ModalHeader>
                <Forms.FormTitle tag="h2" style={{ color: "#00ff88" }}>
                    Bulk Delete My Messages
                </Forms.FormTitle>
            </Modals.ModalHeader>

            <Modals.ModalContent style={{ background: "#000", color: "#00ff88" }}>
                <TextInput
                    value={count}
                    onChange={setCount}
                    disabled={running}
                    placeholder="50"
                    style={{
                        background: "#000",
                        color: "#00ff88",
                        border: "1px solid #00ff88"
                    }}
                />

                <textarea
                    readOnly
                    value={logs.join("\n")}
                    style={{
                        width: "100%",
                        height: 300,
                        marginTop: 12,
                        background: "#000",
                        color: "#00ff88",
                        border: "1px solid #00ff88",
                        fontFamily: "monospace"
                    }}
                />
            </Modals.ModalContent>

            <Modals.ModalFooter style={{ background: "#000" }}>
                <Button
                    disabled={!running}
                    onClick={stopDelete}
                    style={{
                        background: "#111",
                        color: "#00ff88",
                        border: "1px solid #00ff88"
                    }}
                >
                    Stop
                </Button>

                <Button disabled={running} onClick={props.onClose}>
                    Close
                </Button>

                <Button disabled={running} onClick={startDelete}>
                    Delete
                </Button>
            </Modals.ModalFooter>
        </Modals.ModalRoot>
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
    authors: [Devs.sikilmem],

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