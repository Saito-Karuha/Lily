// An example bundle router. Lily calls route() at the start of every run of a session bound to
// `@router` and records the decision in the run manifest; everything else is up to the router.
//
// This one picks the bundle named by the run's `bundle` label, else looks the run's `group`
// label up in the LILY_ROUTES environment variable (a JSON object group → bundle ref), else
// runs the bare kernel:
//
//   LILY_ROUTES='{"bugfix":"demo","implement":"base"}' \
//     lily --router examples/routers/by-label.mjs --bundle @router --label group=bugfix
const routes = JSON.parse(process.env.LILY_ROUTES ?? "{}");

export default {
	name: "by-label",
	route({ labels }) {
		if (labels.bundle) return { bundle: labels.bundle, info: { via: "bundle label" } };
		if (labels.group && routes[labels.group]) return { bundle: routes[labels.group], info: { via: "group", group: labels.group } };
		return { bundle: null, info: { via: "default" } };
	},
};
