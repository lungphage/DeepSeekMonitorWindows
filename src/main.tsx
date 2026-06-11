import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  BarChart3,
  Bell,
  Brain,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  CreditCard,
  Download,
  Info,
  KeyRound,
  Monitor,
  Moon,
  Pin,
  PinOff,
  Power,
  RefreshCw,
  Settings,
  SunMedium,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";

type ViewName = "dashboard" | "settings" | "detail";
type ThemeMode = "dark" | "light" | "system";
type ApiKeyInfo = {
  name: string;
  preview: string;
};
type AppConfig = {
  apiKeyConfigured: boolean;
  apiKeys: ApiKeyInfo[];
  usageTokenConfigured: boolean;
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  balanceAlertThreshold: number | null;
  monthlyBudget: number | null;
  hideOnBlur: boolean;
  configPath: string;
};
type AccountBalance = {
  name: string;
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  error: string | null;
};
type BalanceData = {
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  accounts: AccountBalance[];
};
type BalanceState = "loading" | "ok" | "error" | "nokey";

type UsageModel = {
  key: string;
  name: string;
  totalTokens: number;
  requestCount: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  responseTokens: number;
  cost: number;
};
type DayModelUsage = {
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  response: number;
  cost: number;
};
type UsageDay = {
  date: string;
  totalTokens: number;
  totalCost: number;
  models: Record<string, DayModelUsage>;
};
type UsageResult = {
  models: UsageModel[];
  days: UsageDay[];
  monthCost: number;
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtTokensShort = (n: number) => {
  if (n >= 1e8) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};
const fmtMoney = (n: number) => "¥" + n.toFixed(2);
const fmtMoneyShort = (n: number) => "¥" + (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const mmdd = (date: string) => {
  const parts = date.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date;
};
// 平台接口按北京时间切分日期，这里统一用北京时间算"今天"，
// 避免其他时区用户的当日数据错位。
const beijingNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const todayStr = () => dateKey(beijingNow());
const addDays = (date: Date, offset: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
};
const emptyDay = (date: string): UsageDay => ({
  date,
  totalTokens: 0,
  totalCost: 0,
  models: {},
});
const recentUsageDays = (days: UsageDay[], count = 7): UsageDay[] => {
  const source = new Map(days.filter((day) => day.date <= todayStr()).map((day) => [day.date, day]));
  const today = beijingNow();
  return Array.from({ length: count }, (_, index) => {
    const date = dateKey(addDays(today, index - count + 1));
    return source.get(date) ?? emptyDay(date);
  });
};
// 指定月份的完整逐日序列（当前月截止到今天），缺数据的日期补零。
const monthSeries = (days: UsageDay[], year: number, month: number): UsageDay[] => {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const source = new Map(days.filter((day) => day.date.startsWith(prefix)).map((day) => [day.date, day]));
  const now = beijingNow();
  const isCurrent = now.getFullYear() === year && now.getMonth() + 1 === month;
  const lastDay = isCurrent ? now.getDate() : new Date(year, month, 0).getDate();
  return Array.from({ length: lastDay }, (_, index) => {
    const date = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    return source.get(date) ?? emptyDay(date);
  });
};
const previousMonth = (date: Date) => {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return { month: previous.getMonth() + 1, year: previous.getFullYear() };
};
const fetchMonthUsage = (month: number, year: number) => {
  return invoke<UsageResult>("fetch_usage", { month, year });
};
const fetchCurrentUsage = async () => {
  const now = beijingNow();
  const current = await fetchMonthUsage(now.getMonth() + 1, now.getFullYear());
  const needsPreviousMonth = addDays(now, -6).getMonth() !== now.getMonth();
  if (!needsPreviousMonth) {
    return current;
  }
  try {
    const previous = previousMonth(now);
    const previousUsage = await fetchMonthUsage(previous.month, previous.year);
    return {
      ...current,
      days: [...previousUsage.days, ...current.days],
    };
  } catch {
    return current;
  }
};

// 已知模型沿用原有配色；接口新增的模型从备用色板取色，不再被丢弃。
const MODEL_CLS: Record<string, "flash" | "pro"> = {
  "deepseek-v4-flash": "flash",
  "deepseek-v4-pro": "pro",
};
const OTHER_TINTS = ["#34d399", "#f59e0b", "#f43f5e", "#22d3ee", "#a3e635"];
const modelTint = (key: string, index: number): { cls: string; color: string | null } => {
  const cls = MODEL_CLS[key];
  if (cls) return { cls, color: null };
  return { cls: "other", color: OTHER_TINTS[index % OTHER_TINTS.length] };
};
const ModelBadgeIcon = ({ modelKey, size }: { modelKey: string; size: number }) => {
  if (MODEL_CLS[modelKey] === "flash") return <Zap size={size} fill="currentColor" />;
  if (MODEL_CLS[modelKey] === "pro") return <Brain size={size} />;
  return <Cpu size={size} />;
};

const resolveTheme = (mode: ThemeMode) =>
  mode === "system"
    ? window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark"
    : mode;
const applyThemeAttr = (mode: ThemeMode) => {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
};

const refreshOptions = [
  { label: "1 分钟", value: 60 },
  { label: "5 分钟", value: 300 },
  { label: "30 分钟", value: 1800 },
  { label: "1 小时", value: 3600 },
];

function App() {
  const [view, setView] = React.useState<ViewName>("dashboard");
  const [detailModel, setDetailModel] = React.useState<{ key: string; name: string; tintIndex: number }>({
    key: "deepseek-v4-flash",
    name: "V4 Flash",
    tintIndex: 0,
  });

  const [balance, setBalance] = React.useState<BalanceData | null>(null);
  const [balanceState, setBalanceState] = React.useState<BalanceState>("loading");
  const [balanceError, setBalanceError] = React.useState("");

  const [usage, setUsage] = React.useState<UsageResult | null>(null);
  const [usageState, setUsageState] = React.useState<BalanceState>("loading");
  const [usageError, setUsageError] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = React.useState(60);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(false);
  const [alertThreshold, setAlertThreshold] = React.useState<number | null>(null);
  const [budget, setBudget] = React.useState<number | null>(null);
  const [hideOnBlur, setHideOnBlur] = React.useState(false);
  const [pinned, setPinned] = React.useState(() => localStorage.getItem("ui-pinned") === "1");

  // 刷新时保留旧数据避免界面闪烁；序号守卫丢弃过期响应，防止慢响应覆盖新数据。
  const balanceSeq = React.useRef(0);
  const usageSeq = React.useRef(0);
  const pendingCount = React.useRef(0);

  const trackPending = React.useCallback((delta: number) => {
    pendingCount.current += delta;
    setRefreshing(pendingCount.current > 0);
  }, []);

  const loadBalance = React.useCallback(() => {
    const seq = ++balanceSeq.current;
    trackPending(1);
    setBalanceState((prev) => (prev === "ok" ? prev : "loading"));
    void invoke<BalanceData>("fetch_balance")
      .then((data) => {
        if (seq !== balanceSeq.current) return;
        setBalance(data);
        setBalanceState("ok");
        setBalanceError("");
      })
      .catch((error) => {
        if (seq !== balanceSeq.current) return;
        const message = typeof error === "string" ? error : "查询失败";
        setBalanceError(message);
        setBalanceState(message.includes("未配置") ? "nokey" : "error");
      })
      .finally(() => trackPending(-1));
  }, [trackPending]);

  const loadUsage = React.useCallback(() => {
    const seq = ++usageSeq.current;
    trackPending(1);
    setUsageState((prev) => (prev === "ok" ? prev : "loading"));
    void fetchCurrentUsage()
      .then((data) => {
        if (seq !== usageSeq.current) return;
        setUsage(data);
        setUsageState("ok");
        setUsageError("");
      })
      .catch((error) => {
        if (seq !== usageSeq.current) return;
        const message = typeof error === "string" ? error : "查询失败";
        setUsageError(message);
        setUsage(null);
        setUsageState(message.includes("未配置") ? "nokey" : "error");
      })
      .finally(() => trackPending(-1));
  }, [trackPending]);

  const refreshAll = React.useCallback(() => {
    loadBalance();
    loadUsage();
  }, [loadBalance, loadUsage]);

  React.useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const applyConfig = React.useCallback((config: AppConfig) => {
    setRefreshIntervalSeconds(config.refreshIntervalSeconds || 60);
    setAutoRefreshEnabled(config.autoRefreshEnabled);
    setAlertThreshold(config.balanceAlertThreshold);
    setBudget(config.monthlyBudget);
    setHideOnBlur(config.hideOnBlur);
  }, []);

  React.useEffect(() => {
    void invoke<AppConfig>("get_app_config")
      .then(applyConfig)
      .catch(() => {
        setRefreshIntervalSeconds(60);
        setAutoRefreshEnabled(false);
      });
  }, [applyConfig]);

  React.useEffect(() => {
    if (!autoRefreshEnabled) {
      return;
    }
    const timer = window.setInterval(refreshAll, refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshEnabled, refreshAll, refreshIntervalSeconds]);

  const hideWindow = React.useCallback(() => {
    void invoke("hide_main_window").catch(() => {
      // Browser preview has no Tauri IPC. Keep it non-blocking for visual checks.
    });
  }, []);

  // Esc 隐藏窗口
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hideWindow]);

  // 失焦自动隐藏（置顶时不隐藏）
  const hideOnBlurRef = React.useRef(hideOnBlur);
  hideOnBlurRef.current = hideOnBlur;
  const pinnedRef = React.useRef(pinned);
  pinnedRef.current = pinned;
  React.useEffect(() => {
    const onBlur = () => {
      if (hideOnBlurRef.current && !pinnedRef.current) hideWindow();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [hideWindow]);

  const togglePin = React.useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      localStorage.setItem("ui-pinned", next ? "1" : "0");
      void getCurrentWindow().setAlwaysOnTop(next).catch(() => {});
      return next;
    });
  }, []);

  // 启动时恢复上次的置顶状态
  React.useEffect(() => {
    if (localStorage.getItem("ui-pinned") === "1") {
      void getCurrentWindow().setAlwaysOnTop(true).catch(() => {});
    }
  }, []);

  // 托盘悬停提示：不开窗口也能看到余额和消耗概况
  React.useEffect(() => {
    const parts: string[] = [];
    if (balanceState === "ok" && balance) {
      const symbol = balance.currency === "USD" ? "$" : "¥";
      parts.push(`余额 ${symbol}${balance.totalBalance}`);
    }
    if (usageState === "ok" && usage) {
      const today = usage.days.find((day) => day.date === todayStr());
      parts.push(`今日 ${fmtMoney(today?.totalCost ?? 0)}`);
      parts.push(`本月 ${fmtMoney(usage.monthCost)}`);
    }
    if (parts.length === 0) return;
    void invoke("set_tray_tooltip", { text: `DeepSeek Monitor\n${parts.join("  ")}` }).catch(() => {});
  }, [balance, balanceState, usage, usageState]);

  // 低余额通知：跌破阈值时提醒一次，回升后允许再次提醒
  React.useEffect(() => {
    if (balanceState !== "ok" || !balance || alertThreshold == null) return;
    const total = Number.parseFloat(balance.totalBalance);
    if (Number.isNaN(total)) return;
    const KEY = "notified-balance-low";
    if (total < alertThreshold) {
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, "1");
        void invoke("notify", {
          title: "DeepSeek 余额提醒",
          body: `当前余额 ¥${balance.totalBalance}，已低于提醒阈值 ¥${alertThreshold}`,
        }).catch(() => {});
      }
    } else {
      localStorage.removeItem(KEY);
    }
  }, [balance, balanceState, alertThreshold]);

  // 超预算通知：每个自然月提醒一次
  React.useEffect(() => {
    if (usageState !== "ok" || !usage || budget == null) return;
    const KEY = `notified-budget-${todayStr().slice(0, 7)}`;
    if (usage.monthCost > budget && !localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, "1");
      void invoke("notify", {
        title: "DeepSeek 预算提醒",
        body: `本月已消费 ${fmtMoney(usage.monthCost)}，超出预算 ¥${budget}`,
      }).catch(() => {});
    }
  }, [usage, usageState, budget]);

  return (
    <div className="stage">
      {view === "dashboard" && (
        <DashboardPanel
          balance={balance}
          balanceState={balanceState}
          balanceError={balanceError}
          usage={usage}
          usageState={usageState}
          usageError={usageError}
          refreshing={refreshing}
          budget={budget}
          pinned={pinned}
          onTogglePin={togglePin}
          onRefresh={refreshAll}
          onClose={hideWindow}
          onSettings={() => setView("settings")}
          onDetail={(key, name, tintIndex) => {
            setDetailModel({ key, name, tintIndex });
            setView("detail");
          }}
        />
      )}
      {view === "settings" && (
        <SettingsPanel
          onBalanceChanged={loadBalance}
          onUsageLoaded={(nextUsage) => {
            setUsage(nextUsage);
            setUsageState("ok");
            setUsageError("");
          }}
          onUsageCleared={() => {
            setUsage(null);
            setUsageState("nokey");
            setUsageError("未配置用量 Token");
          }}
          onConfigChanged={applyConfig}
          onBack={() => setView("dashboard")}
        />
      )}
      {view === "detail" && (
        <ModelDetailPanel
          modelKey={detailModel.key}
          modelName={detailModel.name}
          tintIndex={detailModel.tintIndex}
          usage={usage}
          usageState={usageState}
          onBack={() => setView("dashboard")}
        />
      )}
    </div>
  );
}

function BrandIcon({ size = 32 }: { size?: number }) {
  return (
    <div className="brand-icon" style={{ width: size, height: size }}>
      <img src="/assets/deepseek-color.png" alt="DeepSeek" />
    </div>
  );
}

const PLACEHOLDER_MODELS = [
  { key: "deepseek-v4-flash", name: "V4 Flash" },
  { key: "deepseek-v4-pro", name: "V4 Pro" },
];

function DashboardPanel({
  balance,
  balanceState,
  balanceError,
  usage,
  usageState,
  usageError,
  refreshing,
  budget,
  pinned,
  onTogglePin,
  onRefresh,
  onClose,
  onSettings,
  onDetail,
}: {
  balance: BalanceData | null;
  balanceState: BalanceState;
  balanceError: string;
  usage: UsageResult | null;
  usageState: BalanceState;
  usageError: string;
  refreshing: boolean;
  budget: number | null;
  pinned: boolean;
  onTogglePin: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onSettings: () => void;
  onDetail: (key: string, name: string, tintIndex: number) => void;
}) {
  const [theme, setTheme] = React.useState<ThemeMode>(
    () => (localStorage.getItem("ui-theme") as ThemeMode) || "dark",
  );
  React.useEffect(() => {
    applyThemeAttr(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyThemeAttr("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  const cycleTheme = () => {
    const order: ThemeMode[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    localStorage.setItem("ui-theme", next);
  };
  const themeIcon =
    theme === "dark" ? <Moon size={20} /> : theme === "light" ? <SunMedium size={21} /> : <Monitor size={20} />;
  const themeTitle = theme === "dark" ? "深色（点击切换到浅色）" : theme === "light" ? "浅色（点击切换到跟随系统）" : "跟随系统（点击切换到深色）";

  const models = usage?.models ?? [];
  const maxTokens = Math.max(...models.map((item) => item.totalTokens), 1);
  const today = usage?.days.find((day) => day.date === todayStr()) ?? null;
  const yesterday = usage?.days.find((day) => day.date === dateKey(addDays(beijingNow(), -1))) ?? null;
  const todayCost = usageState === "ok" && today ? today.totalCost : null;
  const yesterdayCost = usageState === "ok" && yesterday ? yesterday.totalCost : null;
  const monthCost = usageState === "ok" && usage ? usage.monthCost : null;
  const recent = recentUsageDays(usage?.days ?? []);
  const avg7 = usageState === "ok" ? recent.reduce((sum, day) => sum + day.totalCost, 0) / 7 : null;

  return (
    <section className="panel dashboard-panel" data-testid="dashboard-panel">
      <header className="panel-header" data-tauri-drag-region>
        <div className="title-lockup" data-tauri-drag-region>
          <BrandIcon size={36} />
          <h1>DeepSeek Monitor</h1>
        </div>
        <div className="header-actions">
          <button aria-label="刷新" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={22} className={refreshing ? "spinning" : ""} />
          </button>
          <button
            aria-label="置顶"
            className={pinned ? "pin-toggle active" : "pin-toggle"}
            title={pinned ? "取消置顶" : "置顶窗口"}
            onClick={onTogglePin}
          >
            {pinned ? <Pin size={20} fill="currentColor" /> : <PinOff size={20} />}
          </button>
          <button aria-label="切换主题" className="skin-toggle" title={themeTitle} onClick={cycleTheme}>
            {themeIcon}
          </button>
          <button aria-label="设置" onClick={onSettings}>
            <Settings size={23} />
          </button>
          <button aria-label="关闭" onClick={onClose}>
            <X size={25} />
          </button>
        </div>
      </header>

      <BalanceCard
        balance={balance}
        state={balanceState}
        error={balanceError}
        todayCost={todayCost}
        yesterdayCost={yesterdayCost}
        monthCost={monthCost}
        avg7={avg7}
        budget={budget}
      />

      <div className="usage-stack">
        {(models.length > 0 ? models : PLACEHOLDER_MODELS).map((model, index) => (
          <UsageRow
            key={model.key}
            modelKey={model.key}
            name={model.name}
            tintIndex={index}
            data={models.length > 0 ? (model as UsageModel) : null}
            maxTokens={maxTokens}
            state={usageState}
            onClick={() => onDetail(model.key, model.name, index)}
          />
        ))}
      </div>

      <UsageChart usage={usage} state={usageState} error={usageError} onSettings={onSettings} />
    </section>
  );
}

function BalanceCard({
  balance,
  state,
  error,
  todayCost,
  yesterdayCost,
  monthCost,
  avg7,
  budget,
}: {
  balance: BalanceData | null;
  state: BalanceState;
  error: string;
  todayCost: number | null;
  yesterdayCost: number | null;
  monthCost: number | null;
  avg7: number | null;
  budget: number | null;
}) {
  const symbol = balance?.currency === "USD" ? "$" : "¥";
  const amount =
    state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置"
        : state === "error"
          ? "查询失败"
          : `${symbol}${balance?.totalBalance ?? "0.00"}`;
  const statusText = state === "ok" ? (balance?.isAvailable ? "可用" : "余额不足") : "—";
  const statusOff = state === "ok" && balance != null && !balance.isAvailable;

  // 当日消耗环比昨日
  const trendPct =
    todayCost != null && yesterdayCost != null && yesterdayCost > 0
      ? ((todayCost - yesterdayCost) / yesterdayCost) * 100
      : null;

  // 余额可用天数预测（按近 7 日日均消耗）
  const balanceNum = state === "ok" && balance ? Number.parseFloat(balance.totalBalance) : NaN;
  const forecastDays =
    avg7 != null && avg7 > 0 && !Number.isNaN(balanceNum) && balanceNum > 0
      ? Math.floor(balanceNum / avg7)
      : null;

  const budgetPct = budget != null && monthCost != null ? (monthCost / budget) * 100 : null;

  return (
    <article className="card balance-card">
      <div className="card-title-row">
        <div className="caption-with-icon">
          <CreditCard size={15} />
          <span>账户余额</span>
        </div>
        <div className={`status-pill ${statusOff ? "off" : ""}`}>
          <span />
          {statusText}
        </div>
      </div>
      <div className={`balance-amount ${state !== "ok" ? "balance-dim" : ""}`}>{amount}</div>
      {state === "ok" && balance && (
        <p className="balance-breakdown">
          {balance.accounts.length > 1 ? (
            // 多 Key 时逐个列出各 Key 余额，替代充值/赠金拆分
            balance.accounts.map((account, index) => (
              <React.Fragment key={`${account.name}-${index}`}>
                {index > 0 && " · "}
                {account.name}{" "}
                {account.error
                  ? "查询失败"
                  : `${account.currency === "USD" ? "$" : "¥"}${account.totalBalance}`}
              </React.Fragment>
            ))
          ) : (
            <>
              充值 {symbol}
              {balance.toppedUpBalance} · 赠金 {symbol}
              {balance.grantedBalance}
            </>
          )}
          {forecastDays != null && avg7 != null && (
            <> · 日均 {fmtMoney(avg7)} 约可用 {forecastDays} 天</>
          )}
        </p>
      )}
      {state === "error" && <div className="balance-error">{error}</div>}
      <div className="metric-grid">
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <SunMedium size={15} />
            <span>当日消耗</span>
          </div>
          <strong>
            {todayCost != null ? fmtMoney(todayCost) : "—"}
            {trendPct != null && (
              <span className={`trend ${trendPct > 0 ? "up" : "down"}`}>
                {trendPct > 0 ? "▲" : "▼"}
                {Math.abs(trendPct).toFixed(0)}%
              </span>
            )}
          </strong>
        </div>
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <CalendarDays size={15} />
            <span>本月消费</span>
          </div>
          <strong>{monthCost != null ? fmtMoney(monthCost) : "—"}</strong>
        </div>
      </div>
      {budgetPct != null && budget != null && (
        <div className="budget-line">
          <div className="budget-bar">
            <i className={budgetPct > 100 ? "over" : ""} style={{ width: `${Math.min(100, budgetPct)}%` }} />
          </div>
          <span className={`budget-text ${budgetPct > 100 ? "over" : ""}`}>
            预算 ¥{budget} · 已用 {budgetPct.toFixed(0)}%
          </span>
        </div>
      )}
    </article>
  );
}

function UsageRow({
  modelKey,
  name,
  tintIndex,
  data,
  maxTokens,
  state,
  onClick,
}: {
  modelKey: string;
  name: string;
  tintIndex: number;
  data: UsageModel | null;
  maxTokens: number;
  state: BalanceState;
  onClick: () => void;
}) {
  const tint = modelTint(modelKey, tintIndex);
  const tokensText = data
    ? `${fmtInt(data.totalTokens)} Tokens`
    : state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置 Token"
        : state === "error"
          ? "用量不可用"
          : "—";
  const cost = data ? fmtMoney(data.cost) : "—";
  const ratio = data && data.cost > 0 ? `${fmtTokensShort(data.totalTokens / data.cost)} T/¥` : "—";
  const width = data ? `${Math.max(2, (data.totalTokens / maxTokens) * 100)}%` : "0%";

  return (
    <button className="card usage-row" onClick={onClick}>
      <div
        className={`model-badge ${tint.cls}`}
        style={tint.color ? { background: `${tint.color}29`, color: tint.color } : undefined}
      >
        <ModelBadgeIcon modelKey={modelKey} size={tint.cls === "flash" ? 27 : 25} />
      </div>
      <div className="usage-main">
        <h2>{name}</h2>
        <div className="token-line">
          <span>{tokensText}</span>
          <div className="progress-track">
            <i
              className={tint.cls === "flash" ? "flash-fill" : tint.cls === "pro" ? "pro-fill" : ""}
              style={tint.color ? { width, background: tint.color } : { width }}
            />
          </div>
        </div>
        {data && data.cacheHitTokens + data.cacheMissTokens > 0 && (
          <span
            className={`cache-hit-rate ${tint.cls}`}
            style={tint.color ? { color: tint.color } : undefined}
          >
            缓存命中{" "}
            {((data.cacheHitTokens / (data.cacheHitTokens + data.cacheMissTokens)) * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="usage-price">
        <strong>{cost}</strong>
        <span>{ratio}</span>
      </div>
    </button>
  );
}

function UsageChart({
  usage,
  state,
  error,
  onSettings,
}: {
  usage: UsageResult | null;
  state: BalanceState;
  error: string;
  onSettings: () => void;
}) {
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const MIN_BAR = 3;
  const days = recentUsageDays(usage?.days ?? []);
  const points = days.map((day) => {
    // 全部模型合并统计
    let hit = 0;
    let miss = 0;
    let response = 0;
    for (const model of Object.values(day.models)) {
      hit += model.cacheHit;
      miss += model.cacheMiss;
      response += model.response;
    }
    return { date: day.date, hit, miss, response, total: hit + miss + response };
  });
  const maxVal = Math.max(...points.map((point) => point.total), 1);
  const sumHit = points.reduce((sum, point) => sum + point.hit, 0);
  const sumMiss = points.reduce((sum, point) => sum + point.miss, 0);
  const sumTotal = points.reduce((sum, point) => sum + point.total, 0);
  const hitRate = sumHit + sumMiss > 0 ? ((sumHit / (sumHit + sumMiss)) * 100).toFixed(0) : "0";
  const placeholder =
    state === "loading" ? "查询中…" : state === "nokey" ? "未配置用量 Token" : state === "error" ? error : "暂无数据";

  return (
    <article className="card chart-card">
      <div className="card-title-row">
        <div className="caption-with-icon">
          <BarChart3 size={16} className="brand-blue" />
          <span>缓存命中明细</span>
        </div>
        <span className="chart-total">
          {state === "ok" ? `命中率 ${hitRate}% · 合计 ${fmtTokensShort(sumTotal)}` : "—"}
        </span>
      </div>
      {state === "ok" && points.length > 0 ? (
        <>
          <div className="bars" onMouseLeave={() => setHoveredIdx(null)}>
            {points.map((point, idx) => (
              <div className="bar-column" key={point.date}>
                {hoveredIdx === idx && point.total > 0 && (
                  <div
                    className={`bar-tooltip${
                      idx <= 1 ? " align-left" : idx >= points.length - 2 ? " align-right" : ""
                    }`}
                  >
                    <div className="bar-tooltip-head">
                      <span className="bar-tooltip-date">{point.date}</span>
                      <strong>{fmtInt(point.total)} tokens</strong>
                    </div>
                    <span className="bar-tooltip-row">
                      <i className="dot hit" />输入（命中缓存）
                      <strong>{fmtInt(point.hit)} tokens</strong>
                    </span>
                    <span className="bar-tooltip-row">
                      <i className="dot miss" />输入（未命中缓存）
                      <strong>{fmtInt(point.miss)} tokens</strong>
                    </span>
                    <span className="bar-tooltip-row">
                      <i className="dot response" />输出
                      <strong>{fmtInt(point.response)} tokens</strong>
                    </span>
                  </div>
                )}
                <span className="bar-value">
                  {point.total > 0 ? fmtTokensShort(point.total) : "0"}
                </span>
                <div className="bar-slot">
                  <div
                    className="cache-bar"
                    style={{
                      height: `${point.total > 0 ? Math.max(MIN_BAR, (point.total / maxVal) * 100) : MIN_BAR}%`,
                    }}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  >
                    {point.total > 0 ? (
                      <>
                        {point.hit > 0 && <i className="seg hit" style={{ flexGrow: point.hit }} />}
                        {point.miss > 0 && <i className="seg miss" style={{ flexGrow: point.miss }} />}
                        {point.response > 0 && (
                          <i className="seg response" style={{ flexGrow: point.response }} />
                        )}
                      </>
                    ) : (
                      <i className="seg empty" />
                    )}
                  </div>
                </div>
                <span className="bar-day">{mmdd(point.date)}</span>
              </div>
            ))}
          </div>
          <div className="chart-legend-bottom">
            <span className="chart-legend-item">
              <i className="dot hit" />命中
            </span>
            <span className="chart-legend-item">
              <i className="dot miss" />未命中
            </span>
            <span className="chart-legend-item">
              <i className="dot response" />输出
            </span>
          </div>
        </>
      ) : (
        <div className="chart-placeholder column">
          <span>{placeholder}</span>
          {state === "nokey" && (
            <button className="primary chart-setup-btn" onClick={onSettings}>
              去设置
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function SettingsPanel({
  onBack,
  onBalanceChanged,
  onUsageLoaded,
  onUsageCleared,
  onConfigChanged,
}: {
  onBack: () => void;
  onBalanceChanged: () => void;
  onUsageLoaded: (usage: UsageResult) => void;
  onUsageCleared: () => void;
  onConfigChanged: (config: AppConfig) => void;
}) {
  const [apiKey, setApiKey] = React.useState("");
  const [keyName, setKeyName] = React.useState("");
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [status, setStatus] = React.useState("正在读取本地配置");
  const [busy, setBusy] = React.useState(false);
  const [refresh, setRefresh] = React.useState(60);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [autostart, setAutostart] = React.useState(false);
  const [hideOnBlur, setHideOnBlur] = React.useState(false);
  const [usageToken, setUsageToken] = React.useState("");
  const [usageStatus, setUsageStatus] = React.useState("");
  const [usageSyncing, setUsageSyncing] = React.useState(false);
  const [showManualPaste, setShowManualPaste] = React.useState(false);
  const [alertInput, setAlertInput] = React.useState("");
  const [budgetInput, setBudgetInput] = React.useState("");
  const [alertStatus, setAlertStatus] = React.useState("");
  const [appVersion, setAppVersion] = React.useState("1.1.0");
  const configPath = config?.configPath ?? "%APPDATA%\\DeepSeekMonitorWindows\\config.json";

  const adoptConfig = React.useCallback(
    (nextConfig: AppConfig) => {
      setConfig(nextConfig);
      onConfigChanged(nextConfig);
    },
    [onConfigChanged],
  );

  React.useEffect(() => {
    void invoke<AppConfig>("get_app_config")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setRefresh(nextConfig.refreshIntervalSeconds || 60);
        setAutoRefresh(nextConfig.autoRefreshEnabled);
        setAutostart(nextConfig.autostart);
        setHideOnBlur(nextConfig.hideOnBlur);
        setAlertInput(nextConfig.balanceAlertThreshold != null ? String(nextConfig.balanceAlertThreshold) : "");
        setBudgetInput(nextConfig.monthlyBudget != null ? String(nextConfig.monthlyBudget) : "");
        setStatus(nextConfig.apiKeyConfigured ? `已配置 ${nextConfig.apiKeys.length} 个 API Key` : "未配置 API Key");
        setUsageStatus(nextConfig.usageTokenConfigured ? "用量 Token 已配置" : "未配置用量 Token");
      })
      .catch(() => {
        setStatus("浏览器预览模式，未连接本地配置");
      });
  }, []);

  React.useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("1.1.0"));
  }, []);

  const refreshUsageAfterToken = React.useCallback(
    (prefix: string) => {
      setUsageStatus(`${prefix}，正在刷新用量数据…`);
      return fetchCurrentUsage()
        .then((usage) => {
          onUsageLoaded(usage);
          setUsageStatus(`${prefix}，本月消费 ${fmtMoney(usage.monthCost)}`);
          return usage;
        })
        .catch((error) => {
          const message = typeof error === "string" ? error : "用量刷新失败";
          setUsageStatus(`${prefix}，但用量刷新失败：${message}`);
          throw error;
        });
    },
    [onUsageLoaded],
  );

  React.useEffect(() => {
    const unlistenPromise = listen<AppConfig>("usage-token-captured", (event) => {
      adoptConfig(event.payload);
      setUsageSyncing(false);
      void refreshUsageAfterToken("已通过网页登录自动同步用量 Token");
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [adoptConfig, refreshUsageAfterToken]);

  React.useEffect(() => {
    const unlistenPromise = listen("usage-sync-ended", () => {
      setUsageSyncing(false);
      setUsageStatus("登录窗口已关闭，Token 未获取到。可重新点击同步或使用方式二手动粘贴。");
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // 后端验证通过才会保存，保存成功后刷新主面板余额
  const saveApiKey = React.useCallback(() => {
    setBusy(true);
    setStatus("正在验证 Key…");
    void invoke<AppConfig>("save_api_key", { name: keyName.trim() || null, apiKey })
      .then((nextConfig) => {
        adoptConfig(nextConfig);
        setApiKey("");
        setKeyName("");
        setStatus(`验证通过，已配置 ${nextConfig.apiKeys.length} 个 API Key`);
        onBalanceChanged();
      })
      .catch((error) => {
        setStatus(typeof error === "string" ? error : "保存或验证失败");
      })
      .finally(() => setBusy(false));
  }, [adoptConfig, apiKey, keyName, onBalanceChanged]);

  const removeApiKey = React.useCallback(
    (index: number) => {
      setBusy(true);
      void invoke<AppConfig>("remove_api_key", { index })
        .then((nextConfig) => {
          adoptConfig(nextConfig);
          setStatus(
            nextConfig.apiKeys.length > 0
              ? `已删除，剩余 ${nextConfig.apiKeys.length} 个 API Key`
              : "已清除全部 API Key",
          );
          onBalanceChanged();
        })
        .catch((error) => {
          setStatus(typeof error === "string" ? error : "删除失败");
        })
        .finally(() => setBusy(false));
    },
    [adoptConfig, onBalanceChanged],
  );

  const startUsageSync = React.useCallback(() => {
    setUsageSyncing(true);
    setUsageStatus("正在打开登录窗口…");
    void invoke<boolean>("start_usage_sync")
      .then((synced) => {
        if (!synced) {
          setUsageStatus("登录完成后，再次点击本按钮即可同步用量（可多点几次）");
        }
        // synced=true 时由 usage-token-captured 事件刷新数据并更新状态
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "打开登录窗口失败");
      })
      .finally(() => {
        // 短暂忙碌后自动恢复可点击，允许用户登录后反复点击触发同步
        window.setTimeout(() => setUsageSyncing(false), 2500);
      });
  }, []);

  const saveUsageToken = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("save_usage_token", { usageToken })
      .then((nextConfig) => {
        adoptConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("已保存，正在验证用量 Token…");
        return refreshUsageAfterToken("手动 Token 已保存");
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "保存或验证失败");
      })
      .finally(() => setBusy(false));
  }, [adoptConfig, refreshUsageAfterToken, usageToken]);

  const clearUsageToken = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("clear_usage_token")
      .then((nextConfig) => {
        adoptConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("已清除用量 Token");
        onUsageCleared();
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "清除失败");
      })
      .finally(() => setBusy(false));
  }, [adoptConfig, onUsageCleared]);

  const saveRefreshInterval = React.useCallback(
    (seconds: number) => {
      const previous = refresh;
      setRefresh(seconds);
      void invoke<AppConfig>("save_refresh_interval", { refreshIntervalSeconds: seconds })
        .then((nextConfig) => {
          adoptConfig(nextConfig);
          setRefresh(nextConfig.refreshIntervalSeconds || 60);
        })
        .catch(() => {
          setRefresh(previous);
        });
    },
    [adoptConfig, refresh],
  );

  const saveAutoRefreshEnabled = React.useCallback(
    (enabled: boolean) => {
      const previous = autoRefresh;
      setAutoRefresh(enabled);
      void invoke<AppConfig>("save_auto_refresh_enabled", { autoRefreshEnabled: enabled })
        .then((nextConfig) => {
          adoptConfig(nextConfig);
          setAutoRefresh(nextConfig.autoRefreshEnabled);
        })
        .catch(() => {
          setAutoRefresh(previous);
        });
    },
    [adoptConfig, autoRefresh],
  );

  const saveAutostart = React.useCallback(
    (enabled: boolean) => {
      const previous = autostart;
      setAutostart(enabled);
      void invoke<AppConfig>("save_autostart", { autostart: enabled })
        .then((nextConfig) => {
          adoptConfig(nextConfig);
          setAutostart(nextConfig.autostart);
        })
        .catch(() => setAutostart(previous));
    },
    [adoptConfig, autostart],
  );

  const saveHideOnBlur = React.useCallback(
    (enabled: boolean) => {
      const previous = hideOnBlur;
      setHideOnBlur(enabled);
      void invoke<AppConfig>("save_hide_on_blur", { hideOnBlur: enabled })
        .then((nextConfig) => {
          adoptConfig(nextConfig);
          setHideOnBlur(nextConfig.hideOnBlur);
        })
        .catch(() => setHideOnBlur(previous));
    },
    [adoptConfig, hideOnBlur],
  );

  const saveAlertSettings = React.useCallback(() => {
    const parseAmount = (raw: string): number | null | "invalid" => {
      const text = raw.trim();
      if (!text) return null;
      const value = Number(text);
      return Number.isFinite(value) && value > 0 ? value : "invalid";
    };
    const threshold = parseAmount(alertInput);
    const budget = parseAmount(budgetInput);
    if (threshold === "invalid" || budget === "invalid") {
      setAlertStatus("请输入大于 0 的数字，留空表示不提醒");
      return;
    }
    setBusy(true);
    void invoke<AppConfig>("save_alert_settings", {
      balanceAlertThreshold: threshold,
      monthlyBudget: budget,
    })
      .then((nextConfig) => {
        adoptConfig(nextConfig);
        setAlertStatus("已保存");
      })
      .catch((error) => {
        setAlertStatus(typeof error === "string" ? error : "保存失败");
      })
      .finally(() => setBusy(false));
  }, [adoptConfig, alertInput, budgetInput]);

  return (
    <section className="settings-panel" data-testid="settings-panel">
      <button className="floating-close settings-close" onClick={onBack} aria-label="返回主面板">
        <X size={20} />
      </button>
      <div className="settings-inner">
        <header className="settings-header" data-tauri-drag-region>
          <BrandIcon size={42} />
          <div>
            <h1>DeepSeek Monitor</h1>
            <p>设置</p>
          </div>
        </header>

        <SettingsSection icon={<KeyRound size={15} />} title="API Key">
          <p>用于调用 DeepSeek API 获取余额。可添加多个不同账号的 Key，主面板余额合并显示。</p>
          <p className="muted">API Key 经 Windows DPAPI 加密后只在当前这台电脑本地保留。</p>
          <p className="muted config-path">
            <span>本地位置：</span>
            <span>{configPath}</span>
          </p>
          {(config?.apiKeys ?? []).length > 0 && (
            <div className="key-list">
              {(config?.apiKeys ?? []).map((item, index) => (
                <div className="key-list-row" key={`${item.preview}-${index}`}>
                  <span className="key-list-name">{item.name}</span>
                  <span className="key-list-preview">{item.preview}</span>
                  <button
                    className="secondary"
                    onClick={() => removeApiKey(index)}
                    disabled={busy}
                    aria-label={`删除 ${item.name}`}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="key-row">
            <input
              aria-label="Key 名称"
              value={keyName}
              placeholder="名称（可选，如：账号 A）"
              onChange={(event) => setKeyName(event.target.value)}
            />
          </div>
          <div className="key-row">
            <input
              aria-label="API Key"
              type="password"
              value={apiKey}
              placeholder="sk-..."
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={saveApiKey} disabled={busy || !apiKey.trim()}>
              验证并添加
            </button>
            <span className={config?.apiKeyConfigured ? "configured" : "configured muted-status"}>
              <CheckCircle2 size={17} />
              {config?.apiKeyConfigured ? `已配置 ${config?.apiKeys.length} 个` : "未配置"}
            </span>
          </div>
          <p className="muted">{status}</p>
        </SettingsSection>

        <SettingsSection icon={<BarChart3 size={15} />} title="用量同步 Token">
          <p>用于同步 Token 用量、消费和趋势图。DeepSeek 无官方用量 API，需网页登录 token（与上面的 API Key 不同）。</p>
          <p className="muted">方式一网页登录自动同步</p>
          <div className="settings-actions usage-sync-actions">
            <button className="primary" onClick={startUsageSync} disabled={usageSyncing}>
              {usageSyncing ? "等待登录" : "网页登录自动同步"}
            </button>
            <span className={config?.usageTokenConfigured ? "configured" : "configured muted-status"}>
              <CheckCircle2 size={17} />
              {config?.usageTokenConfigured ? "已配置" : "未配置"}
            </span>
            <button className="secondary" onClick={clearUsageToken} disabled={busy || !config?.usageTokenConfigured}>
              清除 Token
            </button>
          </div>
          <p className="muted">{usageStatus}</p>
          <button
            className="link-button"
            onClick={() => setShowManualPaste((value) => !value)}
          >
            {showManualPaste ? "收起手动粘贴" : "方式二：手动粘贴 token"}
          </button>
          {showManualPaste && (
            <>
              <p className="muted">
                获取：浏览器登录 platform.deepseek.com，按 F12 打开控制台，输入
                JSON.parse(localStorage.userToken).value 回车，复制返回的字符串。
              </p>
              <p className="muted">token 会过期，用量查询失败时重新获取一次即可。</p>
              <div className="key-row">
                <input
                  aria-label="用量 Token"
                  type="password"
                  value={usageToken}
                  placeholder={config?.usageTokenConfigured ? "••••••••••••••••••••••••••••••••••••••••••••••••••" : ""}
                  onChange={(event) => setUsageToken(event.target.value)}
                />
              </div>
              <div className="settings-actions">
                <button className="primary" onClick={saveUsageToken} disabled={busy || !usageToken.trim()}>
                  保存 Token
                </button>
              </div>
            </>
          )}
        </SettingsSection>

        <SettingsSection icon={<Bell size={15} />} title="提醒与预算">
          <p>余额低于阈值或本月消费超出预算时，发送 Windows 系统通知。留空表示不提醒。</p>
          <div className="alert-grid">
            <label className="alert-field">
              <span>余额提醒阈值 ¥</span>
              <input
                className="num-input"
                inputMode="decimal"
                value={alertInput}
                placeholder="如 10"
                onChange={(event) => setAlertInput(event.target.value)}
              />
            </label>
            <label className="alert-field">
              <span>月度预算 ¥</span>
              <input
                className="num-input"
                inputMode="decimal"
                value={budgetInput}
                placeholder="如 100"
                onChange={(event) => setBudgetInput(event.target.value)}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={saveAlertSettings} disabled={busy}>
              保存
            </button>
            <span className="alert-status">{alertStatus}</span>
          </div>
        </SettingsSection>

        <SettingsSection icon={<Power size={15} />} title="开机自启">
          <p>开启后，每次登录 Windows 时自动启动 DeepSeek Monitor。</p>
          <Toggle label="登录时自动启动" checked={autostart} onChange={saveAutostart} />
        </SettingsSection>

        <SettingsSection icon={<RefreshCw size={15} />} title="自动刷新">
          <p>开启后，按设定周期自动从 DeepSeek API 拉取最新数据。</p>
          <Toggle label="启用自动刷新" checked={autoRefresh} onChange={saveAutoRefreshEnabled} />
          {autoRefresh && (
            <div className="segmented">
              {refreshOptions.map((option) => (
                <button
                  key={option.value}
                  className={refresh === option.value ? "selected" : ""}
                  onClick={() => saveRefreshInterval(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection icon={<AppWindow size={15} />} title="窗口行为">
          <p>开启后，点击其他窗口时本面板自动隐藏（已置顶时不隐藏）。按 Esc 也可随时隐藏。</p>
          <Toggle label="失焦后自动隐藏" checked={hideOnBlur} onChange={saveHideOnBlur} />
        </SettingsSection>

        <SettingsSection icon={<Info size={15} />} title="关于">
          <div className="version-row">
            <span>当前版本</span>
            <strong>v{appVersion}</strong>
          </div>
        </SettingsSection>

      </div>
    </section>
  );
}

function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function ModelDetailPanel({
  modelKey,
  modelName,
  tintIndex,
  usage,
  usageState,
  onBack,
}: {
  modelKey: string;
  modelName: string;
  tintIndex: number;
  usage: UsageResult | null;
  usageState: BalanceState;
  onBack: () => void;
}) {
  const tint = modelTint(modelKey, tintIndex);
  const tintStyle = tint.color ? { color: tint.color } : undefined;

  const now = beijingNow();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const [sel, setSel] = React.useState({ year: currentYear, month: currentMonth });
  const isCurrentMonth = sel.year === currentYear && sel.month === currentMonth;

  // 非当前月时单独拉取该月数据；当前月直接复用主面板已有的数据
  const [monthUsage, setMonthUsage] = React.useState<UsageResult | null>(null);
  const [monthState, setMonthState] = React.useState<BalanceState>("loading");
  React.useEffect(() => {
    if (isCurrentMonth) return;
    let cancelled = false;
    setMonthUsage(null);
    setMonthState("loading");
    fetchMonthUsage(sel.month, sel.year)
      .then((data) => {
        if (cancelled) return;
        setMonthUsage(data);
        setMonthState("ok");
      })
      .catch((error) => {
        if (cancelled) return;
        const message = typeof error === "string" ? error : "查询失败";
        setMonthState(message.includes("未配置") ? "nokey" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [isCurrentMonth, sel.month, sel.year]);

  const source = isCurrentMonth ? usage : monthUsage;
  const sourceState = isCurrentMonth ? usageState : monthState;
  const data = source?.models.find((item) => item.key === modelKey) ?? null;
  const cost = data ? fmtMoney(data.cost) : "—";
  const totalText = data ? fmtTokensShort(data.totalTokens) : "—";

  const [range, setRange] = React.useState<"7d" | "month">("7d");
  const effectiveRange = isCurrentMonth ? range : "month";
  const [metric, setMetric] = React.useState<"tokens" | "cost">("tokens");

  const series =
    effectiveRange === "7d"
      ? recentUsageDays(source?.days ?? [])
      : monthSeries(source?.days ?? [], sel.year, sel.month);
  const points = series.map((day) => {
    const model = day.models[modelKey];
    const hit = model?.cacheHit ?? 0;
    const miss = model?.cacheMiss ?? 0;
    const response = model?.response ?? 0;
    const dayCost = model?.cost ?? 0;
    return { date: day.date, hit, miss, response, cost: dayCost, total: hit + miss + response };
  });
  const maxVal = Math.max(...points.map((point) => (metric === "tokens" ? point.total : point.cost)), metric === "tokens" ? 1 : 0.01);
  const rangeText =
    points.length > 0 ? `${mmdd(points[0].date)} - ${mmdd(points[points.length - 1].date)}` : "";
  const monthMode = effectiveRange === "month";

  const shiftMonth = (offset: number) => {
    const next = new Date(sel.year, sel.month - 1 + offset, 1);
    setSel({ year: next.getFullYear(), month: next.getMonth() + 1 });
  };

  const [exportStatus, setExportStatus] = React.useState("");
  const exportCsv = () => {
    setExportStatus("导出中…");
    void invoke<string>("export_usage_csv", { month: sel.month, year: sel.year })
      .then((path) => setExportStatus(`已导出：${path}`))
      .catch((error) => setExportStatus(typeof error === "string" ? error : "导出失败"));
  };

  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const MIN_BAR = 3; // 整根柱子的最小可见高度百分比（含空数据占位）

  const barHeight = (point: (typeof points)[number]) => {
    const value = metric === "tokens" ? point.total : point.cost;
    return value > 0 ? Math.max(MIN_BAR, (value / maxVal) * 100) : MIN_BAR;
  };

  return (
    <section className="panel detail-panel" data-testid="detail-panel">
      <button className="floating-close" onClick={onBack} aria-label="返回主面板">
        <X size={20} />
      </button>
      <article className="card detail-hero" data-tauri-drag-region>
        <div
          className={`model-badge large ${tint.cls}`}
          style={tint.color ? { background: `${tint.color}29`, color: tint.color } : undefined}
        >
          <ModelBadgeIcon modelKey={modelKey} size={tint.cls === "flash" ? 34 : 33} />
        </div>
        <div>
          <h1>{modelName}</h1>
          <p>{cost}</p>
        </div>
      </article>

      <div className="detail-toolbar">
        <div className="month-nav">
          <button aria-label="上个月" onClick={() => shiftMonth(-1)}>
            <ChevronLeft size={16} />
          </button>
          <span>
            {sel.year}年{sel.month}月
          </span>
          <button aria-label="下个月" onClick={() => shiftMonth(1)} disabled={isCurrentMonth}>
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="chip-row">
          {isCurrentMonth && (
            <>
              <button className={`chip ${effectiveRange === "7d" ? "selected" : ""}`} onClick={() => setRange("7d")}>
                近7天
              </button>
              <button
                className={`chip ${effectiveRange === "month" ? "selected" : ""}`}
                onClick={() => setRange("month")}
              >
                全月
              </button>
            </>
          )}
          <button className={`chip ${metric === "tokens" ? "selected" : ""}`} onClick={() => setMetric("tokens")}>
            Tokens
          </button>
          <button className={`chip ${metric === "cost" ? "selected" : ""}`} onClick={() => setMetric("cost")}>
            费用
          </button>
          <button className="chip icon" aria-label="导出 CSV" title="导出当月明细 CSV 到下载文件夹" onClick={exportCsv}>
            <Download size={13} />
          </button>
        </div>
      </div>

      <div className="detail-metrics">
        <article className="card metric-card">
          <span>API 请求次数</span>
          <strong className={tint.cls} style={tintStyle}>
            {data ? fmtInt(data.requestCount) : "—"}
          </strong>
        </article>
        <article className="card metric-card">
          <span>Tokens</span>
          <strong className={tint.cls} style={tintStyle}>
            {totalText}
          </strong>
        </article>
      </div>

      <article className="card detail-chart">
        <div className="detail-chart-head">
          <div>
            <h2>{metric === "tokens" ? "按日 Token 消耗" : "按日费用"}</h2>
            <span>{rangeText}</span>
          </div>
        </div>
        {sourceState === "ok" && points.length > 0 ? (
          <>
            <div
              className={`detail-bars ${monthMode ? "month" : ""}`}
              style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              {points.map((point, idx) => (
                <div className="detail-bar-column" key={point.date}>
                  {hoveredIdx === idx && (metric === "tokens" ? point.total : point.cost) > 0 && (
                    <div
                      className={`bar-tooltip${
                        idx <= 1 ? " align-left" : idx >= points.length - 2 ? " align-right" : ""
                      }`}
                    >
                      <div className="bar-tooltip-head">
                        <span className="bar-tooltip-date">{point.date}</span>
                        <strong>{metric === "tokens" ? `${fmtInt(point.total)} tokens` : fmtMoney(point.cost)}</strong>
                      </div>
                      {metric === "tokens" ? (
                        <>
                          <span className="bar-tooltip-row">
                            <i className="dot hit" />输入（命中缓存）
                            <strong>{fmtInt(point.hit)} tokens</strong>
                          </span>
                          <span className="bar-tooltip-row">
                            <i className="dot miss" />输入（未命中缓存）
                            <strong>{fmtInt(point.miss)} tokens</strong>
                          </span>
                          <span className="bar-tooltip-row">
                            <i className="dot response" />输出
                            <strong>{fmtInt(point.response)} tokens</strong>
                          </span>
                        </>
                      ) : (
                        <span className="bar-tooltip-row">
                          <i className="dot cost" />当日费用
                          <strong>{fmtMoney(point.cost)}</strong>
                        </span>
                      )}
                    </div>
                  )}
                  <span>
                    {monthMode
                      ? ""
                      : metric === "tokens"
                        ? point.total > 0
                          ? fmtTokensShort(point.total)
                          : ""
                        : point.cost > 0
                          ? fmtMoneyShort(point.cost)
                          : ""}
                  </span>
                  <div className="detail-bar-slot">
                    {/* 柱高按当天数值占最大值的比例；token 模式内部三段按真实 token 数分配 */}
                    <div
                      className={`detail-bar-stacked ${monthMode ? "slim" : ""}`}
                      style={{ height: `${barHeight(point)}%` }}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    >
                      {metric === "tokens" && point.total > 0 ? (
                        <>
                          {point.hit > 0 && <i className="seg hit" style={{ flexGrow: point.hit }} />}
                          {point.miss > 0 && <i className="seg miss" style={{ flexGrow: point.miss }} />}
                          {point.response > 0 && <i className="seg response" style={{ flexGrow: point.response }} />}
                        </>
                      ) : metric === "cost" && point.cost > 0 ? (
                        <i className="seg cost" style={{ flexGrow: 1 }} />
                      ) : (
                        <i className="seg empty" />
                      )}
                    </div>
                  </div>
                  <em>{monthMode ? (idx % 5 === 0 || idx === points.length - 1 ? String(idx + 1) : "") : mmdd(point.date)}</em>
                </div>
              ))}
            </div>
            {metric === "tokens" ? (
              <div className="chart-legend-bottom">
                <span className="chart-legend-item"><i className="dot hit" />命中</span>
                <span className="chart-legend-item"><i className="dot miss" />未命中</span>
                <span className="chart-legend-item"><i className="dot response" />输出</span>
              </div>
            ) : (
              <div className="chart-legend-bottom">
                <span className="chart-legend-item"><i className="dot cost" />当日费用</span>
              </div>
            )}
            {exportStatus && <p className="export-status">{exportStatus}</p>}
          </>
        ) : (
          <div className="chart-placeholder">
            {sourceState === "nokey" ? "未配置用量 Token" : sourceState === "loading" ? "查询中…" : "暂无数据"}
          </div>
        )}
      </article>
    </section>
  );
}

// Apply the saved theme before first render to avoid a flash of the wrong skin.
applyThemeAttr(((localStorage.getItem("ui-theme") as ThemeMode) || "dark"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
