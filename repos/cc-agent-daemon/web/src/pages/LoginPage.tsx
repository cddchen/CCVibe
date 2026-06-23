import { useState } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import { useDaemon } from "../context/DaemonContext";
import { defaultWsBase } from "../lib/wsUrl";

export function LoginPage() {
  const { connect, status, error, token, wsUrl } = useDaemon();
  const [base, setBase] = useState(() => wsUrl || defaultWsBase());
  const [tok, setTok] = useState(token);
  const [showToken, setShowToken] = useState(false);
  const connecting = status === "connecting";

  const submit = () => {
    if (connecting || !base.trim()) return;
    connect(base.trim(), tok);
  };

  return (
    <div className="flex min-h-full bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="hidden flex-1 flex-col items-end justify-center bg-black px-12 md:flex">
        <div className="flex flex-col items-end leading-[0.85]">
          <span className="text-[12vw] font-black tracking-tight text-white/90">CC</span>
          <span className="text-[12vw] font-black tracking-tight text-white/60">AGENT</span>
          <span className="text-[12vw] font-black tracking-tight text-white/40">DAEMON</span>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-6 py-12">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-[420px]">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">连接 daemon</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              填写 daemon 的 WS 地址与 token 后连接,即可查看会话列表。
            </p>
          </div>

          <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900/60">
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">WS 地址</label>
            <input
              type="text"
              className="mt-1.5 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-950"
              placeholder={defaultWsBase()}
              value={base}
              onChange={(e) => setBase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />

            <label className="mt-4 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Token</label>
            <div className="mt-1.5 flex gap-2">
              <input
                type={showToken ? "text" : "password"}
                className="min-w-0 flex-1 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-950"
                placeholder="daemon 启动时设置的 token"
                value={tok}
                onChange={(e) => setTok(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                className="shrink-0 rounded-2xl border border-zinc-200 px-3 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {showToken ? "隐藏" : "显示"}
              </button>
            </div>

            {status === "disconnected" && error && (
              <div className="mt-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400">
                连接失败:{error}
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={connecting || !base.trim()}
              className="mt-5 w-full rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connecting ? "连接中…" : "连接"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
