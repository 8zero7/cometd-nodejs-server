'use strict';

const assert = require('assert');
const http = require('http');
const serverLib = require('..');
require('cometd-nodejs-client').adapt();
const clientLib = require('cometd');
const Latch  = require('./latch.js');

describe('extensions', () => {
    let _server;
    let _http;
    let _client;
    let _uri;

    beforeEach(done => {
        _server = serverLib.createCometDServer();
        _http = http.createServer(_server.handle);
        _http.listen(0, 'localhost', () => {
            let port = _http.address().port;
            console.log('listening on localhost:' + port);
            _uri = 'http://localhost:' + port + '/cometd';
            _client = new clientLib.CometD();
            _client.configure({
                url: _uri
            });
            done();
        });
    });

    afterEach(() => {
        _http.close();
        _server.close();
    });

    it('calls extension.incoming', done => {
        let latch = new Latch(3, done);
        _server.addExtension({
            incoming: (cometd, session, message, callback) => {
                latch.signal();
                session.addExtension({
                    incoming: (session, message, callback) => {
                        latch.signal();
                        callback(undefined, true);
                    }
                });
                callback(undefined, true);
            }
        });

        _client.handshake(hs => {
            if (hs.successful) {
                _client.disconnect();
                latch.signal();
            }
        });
    });

    it('deletes message from server extension', done => {
        _server.addExtension({
            incoming: (cometd, session, message, callback) => {
                if (message.channel === '/meta/handshake') {
                    let advice = message.reply.advice || {};
                    message.reply.advice = advice;
                    advice.reconnect = 'none';
                    callback(undefined, false);
                } else {
                    callback(undefined, true);
                }
            }
        });

        _client.handshake(hs => {
            assert.strictEqual(hs.successful, false);
            assert.ok(hs.error);
            assert(hs.error.indexOf('message_deleted') > 0);
            done();
        });
    });

    it('deletes message from session extension', done => {
        _server.addExtension({
            incoming: (cometd, session, message, callback) => {
                session.addExtension({
                    incoming: (session, message, callback) => {
                        if (message.channel === '/meta/handshake') {
                            let advice = message.reply.advice || {};
                            message.reply.advice = advice;
                            advice.reconnect = 'none';
                            callback(undefined, false);
                        } else {
                            callback(undefined, true);
                        }
                    }
                });
                callback(undefined, true);
            }
        });

        _client.handshake(hs => {
            assert.strictEqual(hs.successful, false);
            assert.ok(hs.error);
            assert(hs.error.indexOf('message_deleted') > 0);
            done();
        });
    });

    it('calls extension.outgoing in reverse order', done => {
        let counter = 0;
        _server.addExtension({
            incoming: (cometd, session, message, callback) => {
                if (counter === 0) {
                    counter = 1;
                    session.addExtension({
                        incoming: (session, message, callback) => {
                            if (counter === 2) {
                                counter = 3;
                                callback(undefined, true);
                            } else {
                                callback(new Error('' + counter));
                            }
                        },
                        outgoing: (sender, session, message, callback) => {
                            if (counter === 7) {
                                counter = 8;
                                callback(undefined, message);
                            } else {
                                callback(new Error('' + counter));
                            }
                        }
                    });
                    callback(undefined, true);
                } else {
                    callback(new Error('' + counter));
                }
            },
            outgoing: (cometd, sender, session, message, callback) => {
                if (counter === 5) {
                    counter = 6;
                    callback(undefined, true);
                } else {
                    callback(new Error('' + counter));
                }
            }
        });
        _server.addExtension({
            incoming: (cometd, session, message, callback) => {
                if (counter === 1) {
                    counter = 2;
                    session.addExtension({
                        incoming: (session, message, callback) => {
                            if (counter === 3) {
                                counter = 4;
                                callback(undefined, true);
                            } else {
                                callback(new Error('' + counter));
                            }
                        },
                        outgoing: (sender, session, message, callback) => {
                            if (counter === 6) {
                                counter = 7;
                                callback(undefined, message);
                            } else {
                                callback(new Error('' + counter));
                            }
                        }
                    });
                    callback(undefined, true);
                } else {
                    callback(new Error('' + counter));
                }
            },
            outgoing: (cometd, sender, session, message, callback) => {
                if (counter === 4) {
                    counter = 5;
                    callback(undefined, true);
                } else {
                    callback(new Error('' + counter));
                }
            }
        });

        _client.handshake(hs => {
            assert.strictEqual(hs.successful, true);
            assert.strictEqual(counter, 8);
            _client.disconnect();
            done();
        });
    });
});
