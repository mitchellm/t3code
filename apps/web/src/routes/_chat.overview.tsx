import { createFileRoute } from "@tanstack/react-router";

import { OverviewPage } from "../components/overview/OverviewPage";

export const Route = createFileRoute("/_chat/overview")({
  component: OverviewPage,
});
