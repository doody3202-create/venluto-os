import type { Metadata } from "next";
import Dashboard from "./Dashboard";

export const metadata: Metadata = {
  title: "Today · Venluto OS",
  description: "Venluto's daily outbound operations command center.",
};

export default function Home() { return <Dashboard />; }
