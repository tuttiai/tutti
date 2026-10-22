import { registerWidget, lookupWidget } from "../core/widget-registry.js";
import type { WidgetDefinition } from "../core/widget-registry.js";

export function gammaFeature(): WidgetDefinition | undefined {
  registerWidget({ widgetName: "gamma" });
  return lookupWidget("gamma");
}
