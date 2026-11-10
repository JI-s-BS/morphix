// Setup gate (docs/GOAL.md item 5). In a browser: the first-run wizard until setup is finished,
// then a sign-in screen until someone is signed in, then the app. Inside Electron (the local
// touchscreen kiosk, window.morphix present) the app stays usable without signing in once setup is
// done, and a kiosk that isn't connected to a Morphix server just shows the app.
// The real protection is on the server (packages/config): this gate only decides what to show.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { inElectron } from "../../bridge";
import { ApiError, call, errorText, resetCsrf, type Me, type Status } from "./api";
import { ChangePasswordForm, LoginForm } from "./parts";
import { SessionContext, type SetupSession } from "./session";
import { Wizard } from "./Wizard";
import "./setup.css";

type State =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ok"; status: Status; me: Me };

export function SetupGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const [status, me] = await Promise.all([call<Status>("GET", "/api/setup/status"), call<Me>("GET", "/api/auth/me")]);
      setState({ kind: "ok", status, me });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // Nothing that speaks the Morphix API (no server, or a page served without one): show the app.
      if (status === -1 || status === 404 || (status === 0 && inElectron)) setState({ kind: "unavailable" });
      else setState({ kind: "error", message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await call("POST", "/api/auth/logout");
    } finally {
      resetCsrf();
      await refresh();
    }
  }, [refresh]);

  const session: SetupSession = {
    available: state.kind === "ok",
    user: state.kind === "ok" ? state.me.user : null,
    setupComplete: state.kind === "ok" ? state.status.setupComplete : true,
    refresh,
    logout,
  };
  const wrap = (node: ReactNode) => <SessionContext.Provider value={session}>{node}</SessionContext.Provider>;

  if (state.kind === "loading") return <Splash text="Starting Morphix…" />;
  if (state.kind === "unavailable") return wrap(children);
  if (state.kind === "error") {
    return (
      <Splash text={state.message}>
        <button className="btn primary" onClick={() => { setState({ kind: "loading" }); void refresh(); }}>Try again</button>
      </Splash>
    );
  }

  const { status, me } = state;
  const admin = me.user?.role === "admin";
  if (status.setupOpen || (admin && !status.setupComplete && !me.mustChangePassword)) {
    return wrap(<Wizard setupOpen={status.setupOpen} onSession={refresh} onFinished={refresh} />);
  }
  // The touchscreen next to the printer keeps working without a sign-in once setup is done.
  if (inElectron && status.setupComplete && !me.user) return wrap(children);
  if (!me.user) {
    return wrap(
      <Screen>
        <LoginForm onDone={() => void refresh()} note={status.setupComplete ? undefined : "Setup isn't finished yet. Sign in as the admin to continue it."} />
      </Screen>,
    );
  }
  if (me.mustChangePassword) {
    return wrap(
      <Screen>
        <ChangePasswordForm forced onDone={() => void refresh()} />
      </Screen>,
    );
  }
  if (!status.setupComplete) {
    return wrap(
      <Screen>
        <div className="su-card">
          <h2>Setup isn't finished</h2>
          <p className="su-lead">An admin needs to finish setting up Morphix before it can be used. You're signed in as {me.user.name}.</p>
          <div className="su-actions"><button className="btn" onClick={() => void logout()}>Sign out</button></div>
        </div>
      </Screen>,
    );
  }
  return wrap(children);
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="su-screen">
      <div className="su-wrap" style={{ maxWidth: 520, paddingTop: "6vh" }}>
        <div className="su-brand"><span>Morphix</span></div>
        {children}
      </div>
    </div>
  );
}

function Splash({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="su-screen">
      <div className="empty" style={{ height: "80vh" }}>
        <div>
          <div className="su-brand" style={{ marginBottom: 12 }}><span>Morphix</span></div>
          <div className="muted" style={{ marginBottom: 14 }}>{text}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

export { useSetupSession, type SetupSession } from "./session";
export { SystemSetup } from "./SystemSetup";
