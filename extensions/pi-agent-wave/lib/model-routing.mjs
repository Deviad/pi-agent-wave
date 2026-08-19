/** Resolve a routing tier or role to its ordered model chain and execution metadata. */
export function resolveModel(config, key, mode = "") {
	const tiers = config.tiers ?? {};
	const roles = config.roles ?? {};
	let tier;
	let warning = null;
	if (tiers[key]) tier = key;
	else if (roles[key]) tier = roles[key].tier ?? "";
	else {
		tier = config.default_tier ?? "tools";
		warning = `warning: unknown tier/role '${key}', using default tier '${tier}'`;
	}
	const selected = tiers[tier] ?? {};
	const models = Array.isArray(selected.models) ? selected.models.map(String).filter(Boolean) : [];
	return {
		tier,
		warning,
		models,
		thinking: selected.thinking ?? "off",
		session: Boolean(selected.session),
		primary: models[0] ?? "",
	};
}
