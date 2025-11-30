(function() {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', function() {
        // Version-based cache-buster: keeps first load light while updating on new releases
        var versionTag = (window.__APP_VERSION__ || 'dev').toString();
        navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(versionTag), { scope: '/', updateViaCache: 'none' })
            .then(function(reg) {
                setInterval(function() {
                    reg.update().catch(function(){});
                }, 60 * 60 * 1000);

                navigator.serviceWorker.addEventListener('controllerchange', function() {
                    // no-op
                });
            })
            .catch(function(){ /* no-op */ });
    });

    navigator.serviceWorker.addEventListener('message', function(){ });
})();
