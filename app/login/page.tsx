"use client";

import { FormEvent, useState } from "react";
import styles from "./login.module.css";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) {
      location.href = "/";
      return;
    }
    setError((await response.json()).error ?? "Could not sign in");
    setSubmitting(false);
  }

  return <main className={styles.page}>
    <div className={styles.orbOne}/><div className={styles.orbTwo}/>
    <section className={styles.shell}>
      <aside className={styles.brandPanel}>
        <div className={styles.brand}><span><img src="/venluto-logo.jpeg" alt="Venluto"/></span><div><strong>VENLUTO</strong><small>OPERATING SYSTEM</small></div></div>
        <div className={styles.brandCopy}>
          <span>OUTBOUND INTELLIGENCE</span>
          <h1>Every signal.<br/><em>One clear view.</em></h1>
          <p>Campaign performance, qualified opportunities and pipeline outcomes connected in one private workspace.</p>
        </div>
        <div className={styles.signalCard}>
          <i><img src="/venluto-brain-3d.png" alt=""/></i>
          <span><strong>Live workspace intelligence</strong><small>Campaigns · Replies · Meetings · New MRR</small></span>
          <b>LIVE</b>
        </div>
        <small className={styles.brandFoot}>VENLUTO · OUTBOUND SYSTEMS THAT COMPOUND</small>
      </aside>

      <section className={styles.loginPanel}>
        <div className={styles.mobileBrand}><img src="/venluto-logo.jpeg" alt="Venluto"/><strong>VENLUTO OS</strong></div>
        <div className={styles.loginIntro}><span>SECURE CLIENT PORTAL</span><h2>Welcome back.</h2><p>Enter your credentials to access your workspace.</p></div>
        <form onSubmit={submit} className={styles.form}>
          <label><span>Email address</span><div><i>✉</i><input aria-label="Email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@company.com"/></div></label>
          <label><span>Password</span><div><i>●</i><input aria-label="Password" type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password"/><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.submit} disabled={submitting}>{submitting ? <><i/>Opening workspace…</> : <>Sign in securely <span>→</span></>}</button>
        </form>
        <div className={styles.trust}><span>✓</span><p><strong>Private and protected</strong><small>Your workspace is secured and accessible only to authorized users.</small></p></div>
        <small className={styles.copyright}>© {new Date().getFullYear()} Venluto. All rights reserved.</small>
      </section>
    </section>
  </main>;
}
