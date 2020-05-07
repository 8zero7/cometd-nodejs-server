var crypto = require('crypto');

module.exports = function() {
    function _mixin(target, objects) {
        var result = target || {};
        for (var i = 1; i < arguments.length; ++i) {
            var object = arguments[i];
            if (object === undefined || object === null) {
                continue;
            }
            for (var propName in object) {
                if (Object.prototype.hasOwnProperty.call(object, propName)) {
                    result[propName] = object[propName];
                }
            }
        }
        return result;
    }

    /**
     * Folds (from the left) asynchronously over the given array,
     * invoking the folding function "fn" to process each element
     * of the array.
     *
     * The folding function must have the following signature:
     *   function(result, element, loop)
     * where:
     * - "result" is the accumulated result of element processing
     * (starting from the parameter "zero")
     * - "element" is the n-th element of the array
     * - "loop" is a function(failure, result) that controls the
     *   iteration: when succeeded it produces the accumulated result
     *   (passed to the next invocation of the folding function)
     *   and iterates to the next element, when failed it produces
     *   the failure, stops the iteration and fails "callback"
     *
     * The async feature comes from the fact that the iteration
     * is controlled by invoking the "loop" function, rather than
     * being implicit after the element processing function returns;
     * if the "loop" function is not invoked, the iteration pauses
     * until the "loop" function is invoked.
     *
     * @param array the array of elements to iterate over
     * @param zero the initial result, used also when the array is empty
     * @param fn the folding function that performs element processing and loop control
     * @param callback the function to invoke when the iteration is complete
     * @private
     */
    function _asyncFoldLeft(array, zero, fn, callback) {
        var result = zero;

        function _next(index) {
            for (var i = index; i < array.length; ++i) {
                var sync = false;
                var async = false;
                fn(result, array[i], function(failure, r) {
                    if (failure) {
                        callback(failure);
                    } else {
                        sync = true;
                        result = r;
                        if (async) {
                            _next(i + 1);
                        }
                    }
                });
                if (!sync) {
                    async = true;
                    return;
                }
            }
            callback(null, result);
        }

        _next(0);
    }

    function _addListener(listeners, event, fn) {
        var list = listeners[event];
        if (!list) {
            list = [];
            listeners[event] = list;
        }
        list.push(fn);
    }

    function _removeListener(listeners, event, fn) {
        var list = listeners[event];
        if (list) {
            for (var i = 0; i < list.length; ++i) {
                if (list[i] === fn) {
                    list.splice(i, 1);
                    if (list.length === 0) {
                        delete listeners[event];
                    }
                }
            }
        }
    }

    function _notifyEvent(listeners, args) {
        listeners.forEach(function(listener) {
            listener.apply(undefined, args);
        });
    }

    function _serialize(message) {
        if (!message || message._json) {
            return message;
        } else {
            // Non enumerable property '_json' caches the JSON representation.
            return Object.defineProperty(message, '_json', {
                value: JSON.stringify(message)
            });
        }
    }

    function ServerTransport(cometd) {
        this._option = function(options, prefix, name, dftValue) {
            var result = options[name];
            var segments = prefix.split('.');
            var pfx = null;
            for (var i = 0; i < segments.length; ++i) {
                var segment = segments[i];
                pfx = pfx === null ? segment : pfx + '.' + segment;
                var key = pfx + '.' + name;
                var value = options[key];
                if (value !== undefined) {
                    result = value;
                }
            }
            if (result === undefined) {
                result = dftValue;
            }
            return result;
        };

        this.option = function(name) {
            var dftValue = undefined;
            switch (name) {
                case 'interval':
                    dftValue = 0;
                    break;
                case 'maxInterval':
                    dftValue = 10000;
                    break;
                case 'timeout':
                    dftValue = 30000;
                    break;
            }
            return this._option(cometd.options, '', name, dftValue);
        };

        return this;
    }

    ServerTransport.extends = function(parentObject) {
        function F() {
        }

        F.prototype = parentObject;
        return new F();
    };

    function HTTPTransport(cometd) {
        var _super = new ServerTransport(cometd);
        var _self = ServerTransport.extends(_super);
        var _prefix = 'long-polling.json';
        var _sessions = {};
        var _browserMetaConnects = {};
        var _requests = 0;

        function _parseCookies(text) {
            var cookies = {};
            if (text) {
                text.split(';').forEach(function(cookie) {
                    var parts = cookie.split('=');
                    if (parts.length > 1) {
                        var name = parts[0].trim();
                        cookies[name] = parts[1].trim();
                    }
                });
            }
            return cookies;
        }

        function _findSessions(cookies) {
            for (var cookie in cookies) {
                if (Object.prototype.hasOwnProperty.call(cookies, cookie)) {
                    if (cookie === _self.option('browserCookieName')) {
                        var browserId = cookies[cookie];
                        return _sessions[browserId] || null;
                    }
                }
            }
            return null;
        }

        function _findSession(sessions, message) {
            if (message.channel === '/meta/handshake') {
                return cometd._newServerSession();
            }
            if (sessions) {
                var sessionId = message.clientId;
                for (var i = 0; i < sessions.length; ++i) {
                    var session = sessions[i];
                    if (session.id === sessionId) {
                        return session;
                    }
                }
            }
            return null;
        }

        function _respond(context, local, session, callback) {
            var response = context.response;
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json');

            var content = '[';
            // Serialize the queue.
            var queue = [];
            if (session && local.sendQueue) {
                queue = session._drainQueue(local.replies);
                cometd._log(_prefix, 'sending', queue.length, 'queued messages for', session.id);
                queue.forEach(function(m, i) {
                    if (i > 0) {
                        content += ',';
                    }
                    var json = m._json;
                    if (!json) {
                        json = JSON.stringify(m);
                    }
                    content += json;
                });
            }
            // Serialize the replies.
            cometd._log(_prefix, 'sending', local.replies.length, 'replies for session', session ? session.id : 'null');
            local.replies.forEach(function(reply, i) {
                if (i === 0) {
                    if (queue.length > 0) {
                        content += ',';
                    }
                } else if (i > 0) {
                    content += ',';
                }
                var json = reply._json;
                if (!json) {
                    json = JSON.stringify(reply);
                }
                content += json;
            });
            content += ']';

            var finish = function(failure) {
                cometd._log(_prefix, 'request', '#' + context.id, 'finish for session', session ? session.id : 'null');
                if (session && local.scheduleExpiration) {
                    session._scheduleExpiration(_self.option('interval'), _self.option('maxInterval'));
                }
                callback(failure);
            };

            response.addListener('finish', function() {
                finish();
            });
            response.addListener('error', function(e) {
                finish(e ? e : new Error('response error'));
            });
            var requestError = response._cometd_request_error;
            if (requestError) {
                finish(requestError);
            } else if (!response.socket || response.socket.destroyed) {
                finish(new Error('connection destroyed'));
            } else {
                response.end(content, 'utf8');
            }
        }

        function _addBrowserMetaConnect(session) {
            var maxSessionsPerBrowser = _self.option('maxSessionsPerBrowser');
            if (maxSessionsPerBrowser < 0) {
                return true;
            } else if (maxSessionsPerBrowser === 0) {
                return false;
            }
            var browserId = session._browserId;
            var count = _browserMetaConnects[browserId];
            if (count === undefined) {
                count = _browserMetaConnects[browserId] = 0;
            }
            if (count === maxSessionsPerBrowser) {
                return false;
            }
            ++_browserMetaConnects[browserId];
            return true;
        }

        function _removeBrowserMetaConnect(session) {
            var maxSessionsPerBrowser = _self.option('maxSessionsPerBrowser');
            if (maxSessionsPerBrowser > 0) {
                var browserId = session._browserId;
                var count = _browserMetaConnects[browserId];
                if (count !== undefined) {
                    --_browserMetaConnects[browserId];
                }
            }
        }

        function _advise(reply) {
            var advice = reply.advice;
            if (!advice) {
                advice = reply.advice = {};
            }
            advice.reconnect = 'retry';
            advice.timeout = _self.option('timeout');
            advice.interval = _self.option('interval');
        }

        function _generateCookie(cookieName, cookieValue) {
            var result = cookieName + '=' + cookieValue;
            if (_self.option('browserCookieHttpOnly') === true) {
                result += '; HttpOnly';
            }
            if (_self.option('browserCookieSecure') === true) {
                result += '; Secure';
            }
            var sameSite = _self.option('browserCookieSameSite');
            if (sameSite) {
                result += '; SameSite=' + sameSite;
            }
            return result;
        }

        function _processMetaHandshake(context, session, message, callback) {
            cometd._process(session, message, function(failure, result) {
                if (failure) {
                    callback(failure);
                } else {
                    var reply = message.reply;
                    if (reply.successful) {
                        var cookieName = _self.option('browserCookieName');
                        var browserId = context.cookies[cookieName];
                        if (!browserId) {
                            browserId = crypto.randomBytes(20).toString('hex');
                            context.response.setHeader('Set-Cookie', _generateCookie(cookieName, browserId));
                        }
                        var list = _sessions[browserId];
                        if (!list) {
                            list = [];
                            _sessions[browserId] = list;
                        }
                        list.push(session);
                        session._browserId = browserId;

                        session.addListener('removed', function() {
                            var i = list.indexOf(session);
                            if (i >= 0) {
                                list.splice(i, 1);
                            }
                            if (list.length === 0) {
                                delete _sessions[browserId];
                                delete _browserMetaConnects[browserId];
                            }
                        });
                        _advise(reply);
                    }
                    callback(null, result);
                }
            });
        }

        function _processMetaConnect(context, session, message, canSuspend, callback) {
            if (session) {
                var scheduler = session._scheduler;
                if (scheduler) {
                    scheduler.cancel();
                }
            }

            cometd._process(session, message, function(failure) {
                if (failure) {
                    callback(failure);
                } else {
                    var maySuspend = session && (!session._hasMessages || session._isBatching);
                    var reply = message.reply;
                    if (canSuspend && maySuspend && reply.successful) {
                        var allowSuspend = _addBrowserMetaConnect(session);
                        if (allowSuspend) {
                            if (message.advice) {
                                _advise(reply);
                            }
                            var timeout = session._calculateTimeout(_self.option('timeout'));
                            if (timeout > 0) {
                                var scheduler = {
                                    resume: function() {
                                        if (this._timeout) {
                                            clearTimeout(this._timeout);
                                            this._timeout = null;
                                            session._scheduler = null;
                                            _notifyEvent(session.listeners('resumed'), [session, message, false]);
                                            cometd._log(_prefix, 'resumed wakeup', message);
                                            this._flush();
                                        }
                                    },
                                    cancel: function() {
                                        if (this._timeout) {
                                            clearTimeout(this._timeout);
                                            this._timeout = null;
                                            session._scheduler = null;
                                            _removeBrowserMetaConnect(session);
                                            context.response.statusCode = _self.option('duplicateMetaConnectHttpResponseCode');
                                            callback(new Error('duplicate heartbeat'));
                                        }
                                    },
                                    _expired: function() {
                                        if (this._timeout) {
                                            this._timeout = null;
                                            session._scheduler = null;
                                            _notifyEvent(session.listeners('resumed'), [session, message, true]);
                                            cometd._log(_prefix, 'resumed expire', message);
                                            this._flush();
                                        }
                                    },
                                    _flush: function() {
                                        _removeBrowserMetaConnect(session);
                                        callback(null);
                                    }
                                };
                                scheduler._timeout = setTimeout(function() {
                                    scheduler._expired.call(scheduler);
                                }, timeout);
                                session._scheduler = scheduler;
                                cometd._log(_prefix, 'suspended', message);
                                _notifyEvent(session.listeners('suspended'), [session, message, timeout]);
                            } else {
                                _removeBrowserMetaConnect(session);
                                callback(null);
                            }
                        } else {
                            var advice = reply.advice;
                            if (!advice) {
                                advice = reply.advice = {};
                            }
                            advice['multiple-clients'] = true;

                            var multiSessionInterval = _self.option('multiSessionInterval');
                            if (multiSessionInterval > 0) {
                                advice.reconnect = 'retry';
                                advice.interval = multiSessionInterval;
                            } else {
                                reply.successful = false;
                                advice.reconnect = 'none';
                            }
                            callback(null);
                        }
                    } else {
                        callback(null);
                    }
                }
            });
        }

        function _processMessages(request, response, messages, callback) {
            // An internal context used by the implementation to avoid
            // modifying/altering that given to applications via cometd.context.
            var context = {
                id: ++_requests,
                request: request,
                response: response,
            };

            cometd._log(_prefix, 'processing request', '#' + context.id, 'messages:', messages.length);

            if (messages.length === 0) {
                cometd._log(_prefix, 'invalid request', '#' + context.id, 'no messages');
                response.statusCode = 400;
                response.end();
                callback();
                return;
            }

            var cookies = context.cookies = _parseCookies(request.headers.cookie);
            var sessions = _findSessions(cookies);
            var message = messages[0];
            var session = _findSession(sessions, message);
            cometd._log(_prefix, 'session', session ? session.id : 'null');
            var batch = session && message.channel !== '/meta/connect';
            if (batch) {
                session._startBatch();
            }

            var local = {
                sendQueue: false,
                replies: [],
                scheduleExpiration: false
            };

            _asyncFoldLeft(messages, undefined, function(y, message, loop) {
                cometd._log(_prefix, 'processing', message);
                switch (message.channel) {
                    case '/meta/handshake': {
                        _processMetaHandshake(context, session, message, function(failure) {
                            if (failure) {
                                loop(failure);
                            } else {
                                if (messages.length > 1) {
                                    loop(new Error('protocol violation'));
                                } else {
                                    cometd._extendReply(session, message.reply, function(failure, reply) {
                                        if (failure) {
                                            loop(failure);
                                        } else {
                                            reply = _serialize(reply);
                                            cometd._log(_prefix, 'reply', reply);
                                            if (reply) {
                                                local.replies.push(reply);
                                            }
                                            local.sendQueue = false;
                                            local.scheduleExpiration = true;
                                            loop();
                                        }
                                    });
                                }
                            }
                        });
                        break;
                    }
                    case '/meta/connect': {
                        var canSuspend = messages.length === 1;
                        _processMetaConnect(context, session, message, canSuspend, function(failure) {
                            if (failure) {
                                loop(failure);
                            } else {
                                cometd._extendReply(session, message.reply, function(failure, reply) {
                                    if (failure) {
                                        loop(failure);
                                    } else {
                                        reply = _serialize(reply);
                                        cometd._log(_prefix, 'reply', reply);
                                        if (reply) {
                                            local.replies.push(reply);
                                        }
                                        local.sendQueue = true;
                                        local.scheduleExpiration = true;
                                        loop();
                                    }
                                });
                            }
                        });
                        break;
                    }
                    default: {
                        cometd._process(session, message, function(failure) {
                            if (failure) {
                                loop(failure);
                            } else {
                                cometd._extendReply(session, message.reply, function(failure, reply) {
                                    if (failure) {
                                        loop(failure);
                                    } else {
                                        reply = _serialize(reply);
                                        cometd._log(_prefix, 'reply', reply);
                                        if (reply) {
                                            local.replies.push(reply);
                                        }
                                        local.sendQueue = !(session && session._metaConnectDeliveryOnly);
                                        // Leave scheduleExpiration unchanged.
                                        loop();
                                    }
                                });

                            }
                        });
                    }
                }
            }, function(failure) {
                if (failure) {
                    if (response.statusCode < 400) {
                        response.statusCode = 500;
                    }
                    cometd._log(_prefix, 'request', '#' + context.id, 'failure', response.statusCode, 'for session', session ? session.id : 'null', failure);
                    response.end();
                    callback(failure);
                } else {
                    _respond(context, local, session, callback);
                }
                if (batch) {
                    session._endBatch();
                }
            });
        }

        function _process(request, response, messages) {
            // Sets the context used by applications, so that
            // they can access Node's request and response.
            cometd._setContext({
                request: request,
                response: response
            });
            _processMessages(request, response, messages, function() {
                cometd._setContext(null);
            });
        }

        _self.name = function() {
            return 'long-polling';
        };

        _self.handle = function(request, response) {
            if (request.method === 'POST') {
                if (request.body) {
                    _process(request, response, request.body);
                } else {
                    var content = '';
                    // TODO: limit message size.
                    request.addListener('data', function(chunk) {
                        content += chunk;
                    });
                    request.addListener('end', function() {
                        try {
                            _process(request, response, JSON.parse(content));
                        } catch (failure) {
                            cometd._log(_prefix, failure.stack);
                            response.statusCode = 400;
                            response.end();
                        }
                    });
                    ['aborted', 'error'].forEach(function(event) {
                        request.addListener(event, function(e) {
                            cometd._log(_prefix, 'request', event);
                            response._cometd_request_error = e ? e : new Error('request error');
                        });
                    });
                }
            } else {
                response.statusCode = 400;
                response.end();
            }
        };

        _self.option = function(name) {
            var result = _super.option(name);
            if (result !== undefined) {
                return result;
            }
            var dftValue = undefined;
            switch (name) {
                case 'browserCookieName':
                    dftValue = 'BAYEUX_BROWSER';
                    break;
                case 'browserCookieHttpOnly':
                    dftValue = true;
                    break;
                case 'maxSessionsPerBrowser':
                    dftValue = 1;
                    break;
                case 'multiSessionInterval':
                    dftValue = 2000;
                    break;
                case 'duplicateMetaConnectHttpResponseCode':
                    dftValue = 500;
                    break;
            }
            return this._option(cometd.options, _prefix, name, dftValue);
        };

        return _self;
    }

    /**
     * Representation of a channel.
     *
     * Events emitted:
     * <ul>
     *   <li><code>subscribed</code>, when a ServerSession has subscribed to this channel</li>
     *   <li><code>message</code>, when a message arrives on this channel</li>
     *   <li><code>unsubscribed</code>, when a ServerSession has unsubscribed from this channel</li>
     * </ul>
     *
     * @param cometd the CometD server object
     * @param name the channel name
     * @returns {ServerChannel} a ServerChannel object
     * @constructor
     */
    function ServerChannel(cometd, name) {
        var _wildNames = [];
        var _listeners = {};
        var _subscribers = {};

        if (!name || name.charAt(0) !== '/' || name === '/') {
            throw 'invalid channel ' + name;
        }
        var segments = name.split('/');
        var lastSegment = segments[segments.length - 1];
        if (lastSegment !== '*' && lastSegment !== '**') {
            var c = '/';
            for (var i = segments.length - 1; i > 0; --i) {
                _wildNames.unshift(c + '**');
                if (i > 1) {
                    c += segments[segments.length - i] + '/';
                }
            }
            _wildNames.unshift(c + '*');
        }

        return {
            /**
             * @returns {string} the channel name
             */
            get name() {
                return name;
            },
            /**
             * @returns {boolean} whether this channel is a meta channel
             */
            get meta() {
                return /^\/meta\//.test(name);
            },
            /**
             * @returns {boolean} whether this channel is a service channel
             */
            get service() {
                return /^\/service\//.test(name);
            },
            /**
             * @returns {boolean} whether this channel is a broadcast channel
             */
            get broadcast() {
                return !this.meta && !this.service;
            },
            /**
             * @returns {Array.<string>} the list of parent wild channels
             */
            get wildNames() {
                return _wildNames;
            },
            /**
             * Publishes a message to all subscribers.
             *
             * @param sender the session that sends the message
             * @param data the message data
             * @param callback the callback notified when the publish completes
             */
            publish: function(sender, data, callback) {
                callback = callback || function() {
                    return undefined;
                };
                cometd._publish(this, sender, {
                    channel: name,
                    data: data
                }, false, callback);
            },
            /**
             * @param event the event type
             * @returns {Array.<function>} the listeners for the given event
             */
            listeners: function(event) {
                return _listeners[event] || [];
            },
            /**
             * Adds a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            addListener: function(event, fn) {
                _addListener(_listeners, event, fn);
            },
            /**
             * Removes a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            removeListener: function(event, fn) {
                _removeListener(_listeners, event, fn);
            },
            /**
             * @returns {Array.<ServerSession>} the list of ServerSession subscribed to this channel
             */
            get subscribers() {
                var result = [];
                for (var id in _subscribers) {
                    if (_subscribers.hasOwnProperty(id)) {
                        result.push(_subscribers[id]);
                    }
                }
                return result;
            },

            // PRIVATE APIs.

            _subscribe: function(session, message, callback) {
                if (!session._handshaken || this.meta) {
                    callback(null, false);
                } else {
                    if (this.broadcast) {
                        var existing = _subscribers[session.id];
                        if (!existing) {
                            _subscribers[session.id] = session;
                            session._subscribed(this);
                            _notifyEvent(this.listeners('subscribed'), [this, session, message]);
                            _notifyEvent(cometd.listeners('subscribed'), [this, session, message]);
                        }
                    }
                    callback(null, true);
                }
            },
            _unsubscribe: function(session, message, callback) {
                var existing = _subscribers[session.id];
                if (existing) {
                    delete _subscribers[session.id];
                    session._unsubscribed(this);
                    _notifyEvent(this.listeners('unsubscribed'), [this, session, message]);
                    _notifyEvent(cometd.listeners('unsubscribed'), [this, session, message]);
                }
                callback(null, true);
            },
            _sweep: function() {
                if (this.meta) {
                    return;
                }
                for (var id in _subscribers) {
                    if (_subscribers.hasOwnProperty(id)) {
                        return;
                    }
                }
                for (var event in _listeners) {
                    if (_listeners.hasOwnProperty(event)) {
                        return;
                    }
                }
                cometd._removeServerChannel(this);
            }
        };
    }

    /**
     * Server-side representation of a remote client.
     *
     * Events emitted:
     * <ul>
     *   <li><code>suspended</code>, when a /meta/connect is suspended by the server</li>
     *   <li><code>resumed</code>, when a /meta/connect is resumed by the server</li>
     *   <li><code>removed</code>, when this ServerSession is removed from the server, either explicitly by
     *   disconnecting or because of a timeout</li>
     * </ul>
     *
     *
     * @param cometd the CometD server object
     * @param id the session id
     * @returns {ServerSession} a ServerSession object
     * @constructor
     */
    function ServerSession(cometd, id) {
        var _handshaken = false;
        var _extensions = [];
        var _listeners = {};
        var _subscriptions = [];
        var _queue = [];
        var _clientTimeout = -1;
        var _clientInterval = -1;
        var _batch = 0;
        var _scheduleTime = 0;
        var _expireTime = 0;
        var _metaConnectDeliveryOnly = false;

        function _noop() {
        }

        function _offer(session, message) {
            // TODO: queue maxed ?
            _queue.push(message);
            _notifyEvent(session.listeners('queueOffer'), [session, message]);
        }

        return {
            /**
             * @returns {string} the session id
             */
            get id() {
                return id;
            },
            /**
             * Adds the given extension to the list of extensions.
             * TODO: document extension method signature
             *
             * @param extension the extension to add
             */
            addExtension: function(extension) {
                _extensions.push(extension);
            },
            /**
             * Removes the given extension from the list of extensions.
             *
             * @param extension the extension to remove
             * @return whether the extension was removed
             */
            removeExtension: function(extension) {
                let index = _extensions.indexOf(extension);
                if (index >= 0) {
                    _extensions.splice(index, 1);
                    return true;
                }
                return false;
            },
            /**
             * @returns {*[]} the list of extensions
             */
            get extensions() {
                return _extensions.slice();
            },
            /**
             * @param event the event type
             * @returns {Array.<function>} the listeners for the given event
             */
            listeners: function(event) {
                return _listeners[event] || [];
            },
            /**
             * Adds a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            addListener: function(event, fn) {
                _addListener(_listeners, event, fn);
            },
            /**
             * Removes a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            removeListener: function(event, fn) {
                _removeListener(_listeners, event, fn);
            },
            /**
             * Delivers a message to the remote client represented by this ServerSession.
             *
             * @param {ServerSession} sender the session that sends the message
             * @param {string} channelName the message channel
             * @param {object} data the message data
             * @param {function(*, boolean)} callback the callback notified when the deliver completes
             */
            deliver: function(sender, channelName, data, callback) {
                var message = {
                    channel: channelName,
                    data: data
                };
                cometd._log('cometd.session', 'delivering', message, 'to', this.id);
                this._deliver(sender, message, callback);
            },
            /**
             * @returns {Array.<ServerChannel>} the channels this session is subscribed to
             */
            get subscriptions() {
                return _subscriptions.slice();
            },
            /**
             * Batches the execution of the given function.
             * Messages sent by the execution of the given function are
             * batched and sent only when the function returns.
             *
             * @param fn the batching function
             */
            batch: function(fn) {
                this._startBatch();
                try {
                    fn();
                } finally {
                    this._endBatch();
                }
            },
            /**
             * Disconnects this session from the server side.
             *
             * @param callback the callback notified when the deliver completes
             * @returns {boolean} whether the session has been disconnected
             */
            disconnect: function(callback) {
                var removed = cometd._removeServerSession(this, false);
                if (removed) {
                    this._deliver(this, {
                        successful: true,
                        channel: '/meta/disconnect'
                    }, callback);
                }
                return removed;
            },

            // PRIVATE APIs.

            get _metaConnectDeliveryOnly() {
                return _metaConnectDeliveryOnly;
            },
            set _metaConnectDeliveryOnly(value) {
                _metaConnectDeliveryOnly = value;
            },
            _deliver: function(sender, message, callback) {
                var session = this;
                callback = callback || _noop;
                cometd._extendOutgoing(sender, session, message, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        session._deliver1(sender, message, callback);
                    } else {
                        callback(null, false);
                    }
                });
            },
            _deliver1: function(sender, message, callback) {
                // TODO: avoid delivering to self ?
                var session = this;
                callback = callback || _noop;
                this._extendOutgoing(sender, session, message, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        _offer(session, _serialize(result));
                        if (_batch === 0) {
                            session._flush();
                        }
                        callback(null, true);
                    } else {
                        callback(null, false);
                    }
                });
            },
            get _hasMessages() {
                return _queue.length > 0;
            },
            get _handshaken() {
                return _handshaken;
            },
            _scheduler: null,
            _handshake: function() {
                _handshaken = true;
            },
            _scheduleExpiration: function(dftInterval, dftMaxInterval) {
                _scheduleTime = Date.now();
                var interval = this._calculateInterval(dftInterval);
                _expireTime = _scheduleTime + interval + dftMaxInterval;
            },
            _cancelExpiration: function(metaConnect) {
                if (metaConnect) {
                    _expireTime = 0;
                } else if (_expireTime !== 0) {
                    _expireTime += Date.now() - _scheduleTime;
                }
            },
            _drainQueue: function(replies) {
                _notifyEvent(this.listeners('queueDrain'), [this, _queue, replies]);
                var queue = _queue.slice();
                _queue = [];
                return queue;
            },
            _setClientTimeout: function(timeout) {
                _clientTimeout = timeout;
            },
            _calculateTimeout: function(dftTimeout) {
                if (_clientTimeout >= 0) {
                    return _clientTimeout;
                }
                return dftTimeout;
            },
            _setClientInterval: function(interval) {
                _clientInterval = interval;
            },
            _calculateInterval: function(dftInterval) {
                if (_clientInterval >= 0) {
                    return _clientInterval;
                }
                return dftInterval;
            },
            _subscribed: function(channel) {
                _subscriptions.push(channel);
            },
            _unsubscribed: function(channel) {
                for (var i = 0; i < _subscriptions.length; ++i) {
                    var s = _subscriptions[i];
                    if (s.name === channel.name) {
                        _subscriptions.splice(i, 1);
                        break;
                    }
                }
            },
            _removed: function(timeout) {
                _handshaken = false;
                var self = this;
                _asyncFoldLeft(_subscriptions, undefined, function(y, s, c) {
                    s._unsubscribe(self, null, c);
                }, function() {
                    _notifyEvent(_listeners['removed'], [self, timeout]);
                });
            },
            _flush: function() {
                if (this._scheduler) {
                    this._scheduler.resume();
                }
            },
            _sweep: function() {
                if (_expireTime !== 0) {
                    if (Date.now() > _expireTime) {
                        if (this._scheduler) {
                            this._scheduler.cancel();
                        }
                        cometd._removeServerSession(this, true);
                    }
                }
            },
            _startBatch: function() {
                ++_batch;
            },
            _endBatch: function() {
                --_batch;
                if (_batch === 0 && this._hasMessages) {
                    this._flush();
                }
            },
            get _isBatching() {
                return _batch > 0;
            },
            _extendIncoming: function(message, callback) {
                var session = this;
                _asyncFoldLeft(_extensions, true, function(result, extension, loop) {
                    if (result) {
                        if (extension.incoming) {
                            try {
                                extension.incoming(session, message, function(failure, ret) {
                                    if (failure) {
                                        loop(failure);
                                    } else if (ret === false) {
                                        loop(null, false);
                                    } else {
                                        loop(null, true);
                                    }
                                });
                            } catch (failure) {
                                cometd._log('cometd.session', 'extension failure', failure, failure.stack);
                                loop(null, true);
                            }
                        } else {
                            loop(null, true);
                        }
                    } else {
                        loop(null, false);
                    }
                }, callback);
            },
            _extendOutgoing(sender, session, message, callback) {
                _asyncFoldLeft(_extensions.slice().reverse(), message, function(result, extension, loop) {
                    if (result) {
                        if (extension.outgoing) {
                            try {
                                extension.outgoing(sender, session, result, function(failure, msg) {
                                    if (failure) {
                                        loop(failure);
                                    } else if (msg === undefined) {
                                        loop(null, result);
                                    } else {
                                        loop(null, msg);
                                    }
                                });
                            } catch (failure) {
                                cometd._log('cometd.session', 'extension failure', failure, failure.stack);
                                loop(null, result);
                            }
                        } else {
                            loop(null, result);
                        }
                    } else {
                        loop(null, result);
                    }
                }, callback);
            }
        };
    }

    /**
     * The server-side message broker.
     *
     * Events emitted:
     * <ul>
     *   <li><code>sessionAdded</code>, when a remote session, after a successful handshake, is added to this object</li>
     *   <li><code>sessionRemoved</code>, when a remote session is removed from this object, either explicitly by
     *   disconnecting, or because of a timeout</li>
     *   <li><code>channelAdded</code>, when a ServerChannel is added to this object</li>
     *   <li><code>channelRemoved</code>, when a ServerChannel is removed from this object</li>
     *   <li><code>subscribed</code>, when a ServerSession has subscribed to a ServerChannel</li>
     *   <li><code>unsubscribed</code>, when a ServerSession has unsubscribed from a ServerChannel</li>
     * </ul>
     *
     * @param options the configuration options
     * @returns {CometDServer} a new CometD server
     * @constructor
     */
    var CometDServer = function(options) {
        var _self;
        var _options = _mixin({
            logLevel: 'info',
            sweepPeriod: 997
        }, options);
        var _httpTransport;
        var _extensions = [];
        var _channels = {};
        var _sessions = {};
        var _listeners = {};
        var _context = {};
        var _sweeper;

        function _error(reply, error) {
            reply.successful = false;
            reply.error = error;
        }

        function _unknown(reply) {
            _error(reply, '402::session_unknown');
            if (reply.channel === '/meta/handshake' || reply.channel === '/meta/connect') {
                var advice = reply.advice;
                if (!advice) {
                    advice = reply.advice = {};
                }
                advice.reconnect = 'handshake';
                advice.interval = 0;
            }
        }

        function _canHandshake(session, message, callback) {
            var p = _self.policy;
            if (p && p.canHandshake) {
                p.canHandshake(session, message, callback);
            } else {
                callback(null, true);
            }
        }

        function _canCreate(session, message, channelName, callback) {
            var p = _self.policy;
            if (p && p.canCreate) {
                p.canCreate(session, message, channelName, callback);
            } else {
                callback(null, true);
            }
        }

        function _canSubscribe(session, message, channel, callback) {
            var p = _self.policy;
            if (p && p.canSubscribe) {
                p.canSubscribe(session, message, channel, callback);
            } else {
                callback(null, true);
            }
        }

        function _canPublish(channel, session, message, callback) {
            var p = _self.policy;
            if (p && p.canPublish) {
                p.canPublish(session, message, channel, callback);
            } else {
                callback(null, true);
            }
        }

        function _addServerSession(session, message) {
            _sessions[session.id] = session;
            _notifyEvent(_self.listeners('sessionAdded'), [session, message]);
        }

        function _addServerChannel(channel) {
            _channels[channel.name] = channel;
            _notifyEvent(_self.listeners('channelAdded'), [channel]);
        }

        function _metaHandshake(session, message, callback) {
            _canHandshake(session, message, function(failure, result) {
                if (failure) {
                    callback(failure);
                } else {
                    var reply = message.reply;
                    if (result) {
                        session._handshake();
                        _addServerSession(session, message);
                        reply.successful = true;
                        reply.clientId = session.id;
                        reply.version = "1.0";
                        reply.supportedConnectionTypes = ['long-polling'];
                    } else {
                        _error(reply, '403::handshake_denied');
                        var advice = reply.advice;
                        if (!advice) {
                            advice = reply.advice = {};
                        }
                        if (!advice.reconnect) {
                            advice.reconnect = 'none';
                        }
                    }
                    callback(null, result);
                }
            });
        }

        function _metaConnect(session, message, callback) {
            var adviceIn = message.advice;
            if (adviceIn) {
                var timeout = adviceIn.timeout;
                session._setClientTimeout(timeout === undefined ? -1 : timeout);
                var interval = adviceIn.interval;
                session._setClientInterval(interval === undefined ? -1 : interval);
            } else {
                session._setClientTimeout(-1);
                session._setClientInterval(-1);
            }
            message.reply.successful = true;
            callback();
        }

        function _metaSubscribe(session, message, callback) {
            var reply = message.reply;
            var subscriptions = message.subscription;
            reply.subscription = subscriptions;
            if (subscriptions) {
                if (!Array.isArray(subscriptions)) {
                    subscriptions = [subscriptions];
                }
                _asyncFoldLeft(subscriptions, true, function(processSubscription, subscription, c) {
                    if (processSubscription) {
                        var channel = _self.getServerChannel(subscription);
                        if (!channel) {
                            _canCreate(session, message, subscription, function(failure, result) {
                                if (failure) {
                                    c(failure);
                                } else if (result) {
                                    channel = _self.createServerChannel(subscription);
                                    _canSubscribe(session, message, channel, c);
                                } else {
                                    c(null, false);
                                }
                            });
                        } else {
                            _canSubscribe(session, message, channel, c);
                        }
                    } else {
                        c(null, false);
                    }
                }, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        _asyncFoldLeft(subscriptions, true, function(processSubscription, subscription, c) {
                            if (processSubscription) {
                                var channel = _self.getServerChannel(subscription);
                                channel._subscribe(session, message, c);
                            } else {
                                c(null, false);
                            }
                        }, function(failure2, result2) {
                            if (failure2) {
                                callback(failure2);
                            } else {
                                if (result2) {
                                    reply.successful = true;
                                } else {
                                    _error(reply, '403::subscribe_failed');
                                }
                                callback();
                            }
                        });
                    } else {
                        _error(reply, '403::subscribe_denied');
                        callback();
                    }
                });
            } else {
                _error(reply, "403::subscription_missing");
                callback();
            }
        }

        function _metaUnsubscribe(session, message, callback) {
            var reply = message.reply;
            var subscriptions = message.subscription;
            reply.subscription = subscriptions;
            if (subscriptions) {
                if (!Array.isArray(subscriptions)) {
                    subscriptions = [subscriptions];
                }
                _asyncFoldLeft(subscriptions, true, function(processSubscription, subscription, c) {
                    if (processSubscription) {
                        var channel = _self.getServerChannel(subscription);
                        if (channel) {
                            channel._unsubscribe(session, message, c);
                        } else {
                            c(null, true);
                        }
                    } else {
                        c(null, false);
                    }
                }, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else {
                        if (result) {
                            reply.successful = true;
                        } else {
                            _error(reply, '403::unsubscribe_failed');
                        }
                        callback();
                    }
                });
            } else {
                _error(reply, "403::subscription_missing");
                callback();
            }
        }

        function _metaDisconnect(session, message, callback) {
            var reply = message.reply;
            reply.successful = true;
            _self._removeServerSession(session, false);
            session._flush();
            callback();
        }

        function _notifyListeners(channel, session, message, callback) {
            var channels = [];
            channel.wildNames.forEach(function(wildName) {
                var wild = _self.getServerChannel(wildName);
                if (wild) {
                    channels.push(wild);
                }
            });
            channels.push(channel);
            _asyncFoldLeft(channels, true, function(processChannel, ch, chLoop) {
                if (processChannel) {
                    var listeners = ch.listeners('message');
                    _self._log('cometd.server', 'notifying', listeners.length, 'listeners on', channel.name);
                    _asyncFoldLeft(listeners, true, function(processListener, listener, lsLoop) {
                        if (processListener) {
                            listener(session, ch, message, function(failure, result) {
                                if (failure) {
                                    lsLoop(failure);
                                } else {
                                    if (result === undefined) {
                                        result = true;
                                    }
                                    lsLoop(null, result);
                                }
                            });
                        } else {
                            lsLoop(null, false);
                        }
                    }, chLoop);
                } else {
                    chLoop(null, false);
                }
            }, callback);
        }

        function _notifySubscribers(channel, session, message) {
            var channels = [];
            channel.wildNames.forEach(function(wildName) {
                var wild = _self.getServerChannel(wildName);
                if (wild) {
                    channels.push(wild);
                }
            });
            channels.push(channel);

            // Avoid generating the JSON string for each subscriber.
            message = _serialize(message);

            channels.forEach(function(channel) {
                var subscribers = channel.subscribers;
                _self._log('cometd.server', 'notifying', subscribers.length, 'subscribers on', channel.name);
                subscribers.forEach(function(subscriber) {
                    subscriber._deliver1(session, message);
                });
            });
        }

        function _publish1(channel, session, message, incoming, callback) {
            if (channel.broadcast) {
                _self._extendOutgoing(session, null, message, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        _publish2(channel, session, message, callback);
                    } else {
                        _error(message.reply, '404::message_deleted');
                        callback();
                    }
                });
            } else {
                if (incoming) {
                    _publish2(channel, session, message, callback);
                } else {
                    callback(new Error('cannot publish to non-broadcast channel ' + channel.name));
                }
            }
        }

        function _publish2(channel, session, message, callback) {
            if (channel.meta) {
                switch (channel.name) {
                    case '/meta/handshake':
                        _metaHandshake(session, message, callback);
                        break;
                    case '/meta/connect':
                        _metaConnect(session, message, callback);
                        break;
                    case '/meta/subscribe':
                        _metaSubscribe(session, message, callback);
                        break;
                    case '/meta/unsubscribe':
                        _metaUnsubscribe(session, message, callback);
                        break;
                    case '/meta/disconnect':
                        _metaDisconnect(session, message, callback);
                        break;
                    default:
                        callback(new Error('invalid channel ' + channel.id));
                        break;
                }
            } else {
                if (channel.broadcast) {
                    _notifySubscribers(channel, session, message);
                }
                callback();
            }
        }

        function _process1(session, message, callback) {
            var channelName = message.channel;
            session._cancelExpiration(channelName === '/meta/connect');
            var channel = _channels[channelName];
            if (!channel) {
                _canCreate(session, message, channelName, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        channel = _self.createServerChannel(channelName);
                        _process2(channel, session, message, callback);
                    } else {
                        _error(message.reply, '403::channel_denied');
                        callback();
                    }
                });
            } else {
                _process2(channel, session, message, callback);
            }
        }

        function _process2(channel, session, message, callback) {
            var reply = message.reply;
            if (channel.meta) {
                _self._publish(channel, session, message, true, callback);
            } else {
                _canPublish(channel, session, message, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        reply.successful = true;
                        _self._publish(channel, session, message, true, callback);
                    } else {
                        _error(reply, '403::publish_denied');
                        callback();
                    }
                });
            }
        }

        function _sweep() {
            for (var name in _channels) {
                if (_channels.hasOwnProperty(name)) {
                    _channels[name]._sweep();
                }
            }
            for (var id in _sessions) {
                if (_sessions.hasOwnProperty(id)) {
                    _sessions[id]._sweep();
                }
            }
            // TODO: need to sweep transports too?
            _sweeper = setTimeout(_sweep, _self.options.sweepPeriod);
        }

        _self = {
            /**
             * @returns {object} the options for this CometD server.
             */
            get options() {
                return _options;
            },
            /**
             * The security policy object that is interrogated for authorization.
             * It may define zero or all of the following methods, and the
             * callback parameters must be completed either by an error at
             * the first parameter, or by a truthy value at the second parameter.
             * If a method is missing, it is implied that the authorization is granted.
             * <ul>
             *   <li><code>canHandshake(session, message, callback)</code></li>
             *   <li><code>canCreate(session, message, channelName, callback)</code></li>
             *   <li><code>canSubscribe(session, message, channel, callback)</code></li>
             *   <li><code>canPublish(session, message, channel, callback)</code></li>
             * </ul>
             */
            policy: null,
            /**
             * Adds a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            addListener: function(event, fn) {
                _addListener(_listeners, event, fn);
            },
            /**
             * Removes a listener function for the given event.
             *
             * @param {string} event the event type
             * @param {function} fn the listener function
             */
            removeListener: function(event, fn) {
                _removeListener(_listeners, event, fn);
            },
            /**
             * @param {string} event the event type
             * @returns {Array} the listeners for the given event
             */
            listeners: function(event) {
                return _listeners[event] || [];
            },
            /**
             * Adds the given extension to the list of extensions.
             * TODO: document extension method signature
             *
             * @param extension the extension to add
             */
            addExtension: function(extension) {
                _extensions.push(extension);
            },
            /**
             * Removes the given extension from the list of extensions.
             *
             * @param extension the extension to remove
             * @return whether the extension was removed
             */
            removeExtension: function(extension) {
                let index = _extensions.indexOf(extension);
                if (index >= 0) {
                    _extensions.splice(index, 1);
                    return true;
                }
                return false;
            },
            /**
             * @returns {*[]} the list of extensions
             */
            get extensions() {
                return _extensions.slice();
            },
            /**
             * The function that handles HTTP request and response,
             * typically to be passed to Node's HTTP server.
             * <pre>
             * var http = require('http');
             * var cometd = require('cometd-nodejs-server');
             * var cometdServer = cometd.createCometDServer();
             * var httpServer = http.createServer(cometdServer.handle);
             * </pre>
             *
             * @param request the HTTP request
             * @param response the HTTP response
             */
            handle: function(request, response) {
                _httpTransport.handle(request, response);
            },
            /**
             * @param name the channel name
             * @returns {ServerChannel} a ServerChannel with the given name,
             * or nothing if there is no channel with the given name
             * @see #createServerChannel
             */
            getServerChannel: function(name) {
                return _channels[name];
            },
            /**
             * Returns a ServerChannel with the given name.
             * If the channel already exists, returns it;
             * otherwise the channel is created and cached.
             *
             * @param name the channel name
             * @returns {ServerChannel} a ServerChannel with the given name
             * @see #getServerChannel
             */
            createServerChannel: function(name) {
                var channel = _self.getServerChannel(name);
                if (!channel) {
                    channel = new ServerChannel(_self, name);
                    _addServerChannel(channel);
                }
                return channel;
            },
            /**
             * @param id the session id
             * @returns {ServerSession} a ServerSession with the given session id,
             * or nothing if there is no session with the given id
             */
            getServerSession: function(id) {
                return _sessions[id];
            },
            /**
             * Returns a map of contextual information related to the message processing.
             *
             * @returns {object}
             */
            get context() {
                return _context;
            },
            /**
             * Closes this CometD server, stopping its activities.
             */
            close: function() {
                clearTimeout(_sweeper);
            },

            // PRIVATE APIs.

            _setContext: function(context) {
                if (context) {
                    _mixin(_context, context);
                } else {
                    for (var k in _context) {
                        if (Object.prototype.hasOwnProperty.call(_context, k)) {
                            delete _context[k];
                        }
                    }
                }
            },
            _process: function(session, message, callback) {
                var reply = {
                    id: message.id,
                    channel: message.channel
                };

                // Non enumerable property 'reply' to avoid serializing
                // the reply property of client-side published messages.
                Object.defineProperty(message, 'reply', {
                    value: reply
                });

                if (!session) {
                    _unknown(reply);
                    callback();
                } else {
                    if (!message.channel) {
                        _error(reply, '400::channel_missing');
                        callback();
                    } else {
                        this._extendIncoming(session, message, function(failure, result) {
                            if (failure) {
                                callback(failure);
                            } else if (result) {
                                if (session) {
                                    session._extendIncoming(message, function(failure, result) {
                                        if (failure) {
                                            callback(failure);
                                        } else if (result) {
                                            _process1(session, message, callback);
                                        } else {
                                            _error(reply, '404::message_deleted');
                                            callback();
                                        }
                                    });
                                } else {
                                    _process1(session, message, callback);
                                }
                            } else {
                                _error(reply, '404::message_deleted');
                                callback();
                            }
                        });
                    }
                }
            },
            _publish: function(channel, session, message, incoming, callback) {
                _self._log('cometd.server', 'publishing to', channel.name, message);
                var broadcast = channel.broadcast;
                if (broadcast) {
                    delete message.id;
                    delete message.clientId;
                }
                _notifyListeners(channel, session, message, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        _publish1(channel, session, message, incoming, callback);
                    } else {
                        // TODO: message has been deleted, call _error()?
                        callback();
                    }
                });
            },
            _extendIncoming: function(session, message, callback) {
                _asyncFoldLeft(_extensions, true, function(result, extension, loop) {
                    if (result) {
                        if (extension.incoming) {
                            try {
                                extension.incoming(_self, session, message, function(failure, ret) {
                                    if (failure) {
                                        loop(failure);
                                    } else if (ret === false) {
                                        loop(null, false);
                                    } else {
                                        loop(null, true);
                                    }
                                });
                            } catch (failure) {
                                _self._log('cometd.server', 'extension failure', failure, failure.stack);
                                loop(null, true);
                            }
                        } else {
                            loop(null, true);
                        }
                    } else {
                        loop(null, false);
                    }
                }, callback);
            },
            _extendOutgoing: function(sender, session, message, callback) {
                _asyncFoldLeft(_extensions.slice().reverse(), true, function(result, extension, loop) {
                    if (result) {
                        if (extension.outgoing) {
                            try {
                                extension.outgoing(_self, session, session, message, function(failure, ret) {
                                    if (failure) {
                                        loop(failure);
                                    } else if (ret === false) {
                                        loop(null, false);
                                    } else {
                                        loop(null, true);
                                    }
                                });
                            } catch (failure) {
                                _self._log('cometd.server', 'extension failure', failure, failure.stack);
                                loop(null, true);
                            }
                        } else {
                            loop(null, true);
                        }
                    } else {
                        loop(null, false);
                    }
                }, callback);
            },
            _extendReply: function(session, reply, callback) {
                this._extendOutgoing(session, session, reply, function(failure, result) {
                    if (failure) {
                        callback(failure);
                    } else if (result) {
                        if (session) {
                            session._extendOutgoing(session, session, reply, callback);
                        } else {
                            callback(null, reply);
                        }
                    } else {
                        callback(null, null);
                    }
                });
            },
            _newServerSession: function() {
                var id = crypto.randomBytes(20).toString('hex');
                return new ServerSession(_self, id);
            },
            _removeServerSession: function(session, timeout) {
                var existing = _sessions[session.id];
                if (existing) {
                    delete _sessions[session.id];
                    _notifyEvent(_self.listeners('sessionRemoved'), [session, timeout]);
                    session._removed(timeout);
                }
                return existing;
            },
            _removeServerChannel: function(channel) {
                var existing = _channels[channel.name];
                if (existing) {
                    delete _channels[channel.name];
                    _notifyEvent(_self.listeners('channelRemoved'), [channel]);
                }
                return existing;
            },
            _log: function _log(tag, format, args) {
                if (this.options.logLevel === 'debug') {
                    args = [].slice.call(arguments);
                    args.splice(0, 2, new Date().toISOString() + ':' + tag + ': ' + format);
                    console.log.apply(console, args);
                }
            }
        };

        _channels['/meta/handshake'] = _self.createServerChannel('/meta/handshake');
        _channels['/meta/connect'] = _self.createServerChannel('/meta/connect');
        _channels['/meta/subscribe'] = _self.createServerChannel('/meta/subscribe');
        _channels['/meta/unsubscribe'] = _self.createServerChannel('/meta/unsubscribe');
        _channels['/meta/disconnect'] = _self.createServerChannel('/meta/disconnect');

        _httpTransport = new HTTPTransport(_self);

        _sweep();

        return _self;
    };

    return {
        /**
         * @param {object} options the configuration options
         * @returns {CometDServer} a new CometDServer with the given configuration options
         */
        createCometDServer: function(options) {
            return new CometDServer(options);
        }
    };
}();
