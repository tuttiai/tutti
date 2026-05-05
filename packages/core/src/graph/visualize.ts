/**
 * Standalone HTML/SVG graph visualizer.
 *
 * {@link renderGraph} converts a {@link GraphConfig} into a self-contained
 * HTML page that renders the graph using a D3-force layout. The page loads
 * D3 from a CDN and needs no build step — just open the HTML in a browser.
 *
 * A static `<noscript>` SVG is also embedded so the node IDs are present
 * in the raw HTML even without JavaScript execution (useful for tests and
 * server-side assertions).
 */

import type { GraphConfig } from "./types.js";
import { END } from "./types.js";

/** Serialisable node representation for the embedded JSON. */
interface VisNode {
  id: string;
  label: string;
  description?: string;
  merge?: boolean;
}

/** Serialisable edge representation for the embedded JSON. */
interface VisEdge {
  source: string;
  target: string;
  label?: string;
  parallel?: boolean;
  /**
   * `true` when the source edge had a `condition` predicate. The function
   * itself cannot be serialised, so we surface only this flag — frontends
   * use it to render conditional edges differently (e.g. dashed).
   */
  has_condition?: boolean;
}

/**
 * Extract a serialisable graph structure from a {@link GraphConfig}.
 *
 * Condition functions cannot be serialised — they are replaced by a
 * boolean flag (`has_condition`) so the frontend can style conditional
 * edges differently.
 */
function extractVisData(config: GraphConfig): { nodes: VisNode[]; edges: VisEdge[] } {
  const nodes: VisNode[] = config.nodes.map((n) => ({
    id: n.id,
    label: n.agent.name,
    description: n.description,
    merge: n.merge,
  }));

  // Add the END sentinel as a visible terminal node
  const hasEndEdge = config.edges.some((e) => e.to === END);
  if (hasEndEdge) {
    nodes.push({ id: END, label: "END" });
  }

  const edges: VisEdge[] = config.edges.map((e) => ({
    source: e.from,
    target: e.to,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.parallel !== undefined ? { parallel: e.parallel } : {}),
    ...(e.condition !== undefined ? { has_condition: true } : {}),
  }));

  return { nodes, edges };
}

/**
 * Build a static SVG string with a simple vertical layout.
 *
 * This is the `<noscript>` fallback and the testable artefact — each
 * node ID appears as a `<text>` element inside an SVG `<g>` group.
 */
function buildStaticSvg(nodes: VisNode[], edges: VisEdge[]): string {
  const nodeSpacing = 100;
  const svgWidth = 600;
  const startY = 60;
  const nodeWidth = 140;
  const nodeHeight = 40;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    positions.set(n.id, {
      x: svgWidth / 2,
      y: startY + i * nodeSpacing,
    });
  });

  const svgHeight = startY + nodes.length * nodeSpacing + 40;

  const nodeEls = nodes
    .map((n) => {
      const pos = positions.get(n.id);
      if (!pos) return "";
      const isEnd = n.id === END;
      const fill = isEnd ? "#555" : "#2563eb";
      return [
        `<g data-node-id="${n.id}">`,
        `  <rect x="${pos.x - nodeWidth / 2}" y="${pos.y - nodeHeight / 2}" ` +
          `width="${nodeWidth}" height="${nodeHeight}" rx="8" ` +
          `fill="${fill}" />`,
        `  <text x="${pos.x}" y="${pos.y + 5}" text-anchor="middle" ` +
          `fill="white" font-family="system-ui" font-size="14">${n.id}</text>`,
        `</g>`,
      ].join("\n    ");
    })
    .join("\n    ");

  const edgeEls = edges
    .map((e) => {
      const src = positions.get(e.source);
      const tgt = positions.get(e.target);
      if (!src || !tgt) return "";
      const dash = e.parallel ? ' stroke-dasharray="6 3"' : "";
      return [
        `<line x1="${src.x}" y1="${src.y + nodeHeight / 2}" ` +
          `x2="${tgt.x}" y2="${tgt.y - nodeHeight / 2}" ` +
          `stroke="#94a3b8" stroke-width="2" marker-end="url(#arrow)"${dash} />`,
        e.label
          ? `<text x="${(src.x + tgt.x) / 2 + 10}" ` +
            `y="${(src.y + tgt.y) / 2}" fill="#94a3b8" ` +
            `font-family="system-ui" font-size="11">${e.label}</text>`
          : "",
      ]
        .filter(Boolean)
        .join("\n    ");
    })
    .join("\n    ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`,
    `  <defs>`,
    `    <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"`,
    `      markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />`,
    `    </marker>`,
    `  </defs>`,
    `  ${edgeEls}`,
    `  ${nodeEls}`,
    `</svg>`,
  ].join("\n");
}

/**
 * Render a {@link GraphConfig} as a self-contained HTML page.
 *
 * The page embeds the graph data as JSON, loads D3 v7 from a CDN, and
 * renders an interactive force-directed SVG. A static SVG is included
 * inside `<noscript>` for environments without JavaScript.
 *
 * @param config - The graph configuration to visualise.
 * @returns A complete HTML string ready to write to a file or serve.
 */
export function renderGraph(config: GraphConfig): string {
  const { nodes, edges } = extractVisData(config);
  const staticSvg = buildStaticSvg(nodes, edges);
  const graphJson = JSON.stringify({ nodes, edges, entrypoint: config.entrypoint });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TuttiGraph — ${config.entrypoint}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; }
  #graph { width: 100vw; height: 100vh; }
  .node rect { cursor: pointer; transition: fill 0.2s; }
  .node rect.active { fill: #f59e0b !important; }
  .node text { pointer-events: none; }
  .edge line { transition: stroke 0.2s; }
  .edge-label { font-size: 11px; fill: #94a3b8; }
  .legend { position: fixed; bottom: 16px; left: 16px; font-size: 12px; color: #64748b; }
</style>
</head>
<body>
<div id="graph"></div>
<noscript>${staticSvg}</noscript>
<div class="legend">TuttiGraph · ${config.nodes.length} nodes · ${config.edges.length} edges</div>
<script type="application/json" id="graph-data">${graphJson}</script>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>
<script>
(function() {
  var data = JSON.parse(document.getElementById("graph-data").textContent);
  var width = window.innerWidth;
  var height = window.innerHeight;

  var svg = d3.select("#graph")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  svg.append("defs").append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 28).attr("refY", 5)
    .attr("markerWidth", 6).attr("markerHeight", 6)
    .attr("orient", "auto-start-reverse")
    .append("path").attr("d", "M 0 0 L 10 5 L 0 10 z").attr("fill", "#64748b");

  var nodeById = {};
  data.nodes.forEach(function(n) { nodeById[n.id] = n; });

  var simulation = d3.forceSimulation(data.nodes)
    .force("link", d3.forceLink(data.edges).id(function(d) { return d.id; }).distance(160))
    .force("charge", d3.forceManyBody().strength(-400))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("y", d3.forceY(height / 2).strength(0.05));

  var link = svg.selectAll(".edge")
    .data(data.edges).enter().append("g").attr("class", "edge");

  link.append("line")
    .attr("stroke", "#475569")
    .attr("stroke-width", 2)
    .attr("marker-end", "url(#arrowhead)")
    .attr("stroke-dasharray", function(d) { return d.parallel ? "6 3" : null; });

  link.append("text")
    .attr("class", "edge-label")
    .text(function(d) { return d.label || ""; });

  var node = svg.selectAll(".node")
    .data(data.nodes).enter().append("g").attr("class", "node")
    .call(d3.drag()
      .on("start", function(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", function(event, d) { d.fx = event.x; d.fy = event.y; })
      .on("end", function(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  node.append("rect")
    .attr("width", 120).attr("height", 40).attr("rx", 8)
    .attr("x", -60).attr("y", -20)
    .attr("fill", function(d) {
      if (d.id === "__end__") return "#475569";
      if (d.id === data.entrypoint) return "#16a34a";
      if (d.merge) return "#9333ea";
      return "#2563eb";
    });

  node.append("text")
    .attr("text-anchor", "middle").attr("dy", 5)
    .attr("fill", "white").attr("font-size", 13)
    .text(function(d) { return d.id; });

  simulation.on("tick", function() {
    link.select("line")
      .attr("x1", function(d) { return d.source.x; })
      .attr("y1", function(d) { return d.source.y; })
      .attr("x2", function(d) { return d.target.x; })
      .attr("y2", function(d) { return d.target.y; });
    link.select("text")
      .attr("x", function(d) { return (d.source.x + d.target.x) / 2; })
      .attr("y", function(d) { return (d.source.y + d.target.y) / 2 - 8; });
    node.attr("transform", function(d) { return "translate(" + d.x + "," + d.y + ")"; });
  });

  /* ── SSE highlight (works when served from Tutti Studio) ──── */
  if (typeof EventSource !== "undefined") {
    try {
      var es = new EventSource("/events");
      es.onmessage = function(msg) {
        try {
          var ev = JSON.parse(msg.data);
          if (ev.type === "node:start") {
            svg.selectAll(".node rect").classed("active", false);
            svg.selectAll(".node").filter(function(d) { return d.id === ev.node_id; })
              .select("rect").classed("active", true);
          }
          if (ev.type === "node:end" || ev.type === "graph:end") {
            svg.selectAll(".node rect").classed("active", false);
          }
        } catch(e) {}
      };
    } catch(e) {}
  }
})();
<\/script>
</body>
</html>`;
}

/**
 * Convert a {@link GraphConfig} to a plain JSON-serialisable object.
 *
 * Condition functions are dropped (they are not serialisable).
 * Used by the `GET /graph` server endpoint.
 */
export function graphToJSON(config: GraphConfig): Record<string, unknown> {
  const { nodes, edges } = extractVisData(config);
  return {
    entrypoint: config.entrypoint,
    nodes,
    edges,
    has_state: !!config.state,
  };
}
