function inferModulesFromNeeds(needs) {
  const normalized = (needs || []).map((item) => String(item).toLowerCase());
  const modules = new Set();

  for (const need of normalized) {
    if (need.includes("access") || need.includes("gate")) {
      modules.add("access_control");
    }
    if (need.includes("security") || need.includes("incident")) {
      modules.add("security_workflows");
    }
    if (need.includes("resident") || need.includes("community")) {
      modules.add("resident_services");
    }
    if (need.includes("monitor") || need.includes("sensor")) {
      modules.add("smart_monitoring");
    }
    if (
      need.includes("facility") ||
      need.includes("maintenance") ||
      need.includes("operations")
    ) {
      modules.add("facility_operations");
    }
    if (
      need.includes("utility") ||
      need.includes("power") ||
      need.includes("water") ||
      need.includes("infrastructure")
    ) {
      modules.add("connected_infrastructure");
    }
  }

  return Array.from(modules);
}

function getSolutionFit({ project_type, unit_count, needs, timeline }) {
  const type = String(project_type || "unknown").toLowerCase();
  const modules = inferModulesFromNeeds(needs);

  let solutionPath = "oyi_core";
  if (type.includes("estate") || type.includes("community")) {
    solutionPath = "oyi_estate_operations";
  } else if (type.includes("facility") || type.includes("building")) {
    solutionPath = "oyi_facility_operations";
  } else if (type.includes("utility") || type.includes("infrastructure")) {
    solutionPath = "ochiga_connected_infrastructure";
  }

  if (modules.length === 0) {
    modules.push("facility_operations");
  }

  return {
    recommended_path: solutionPath,
    recommended_modules: modules,
    project_type,
    unit_count: Number.isFinite(Number(unit_count)) ? Number(unit_count) : null,
    timeline: timeline || "unknown",
    rationale:
      "Recommended from project type and stated operational needs. Commercial scope still needs sales or human validation.",
  };
}

module.exports = {
  getSolutionFit,
};
