var EventHelper = {

	// attach events in map to subject
	bindEventMap: function(subject, map) {
		Object.keys(map).forEach(function(name) {
			subject.addEventListener(name, map[name]);
		});
	},

	unbindEventMap: function(subject, map) {
		Object.keys(map).forEach(function(name) {
			subject.removeEventListener(name, map[name]);
		});
	}
}
