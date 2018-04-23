var async = require('async');
var request = require('request');
var ip = require('ip');
var util = require('util');
var extend = require('extend');
var crypto = require('crypto');
var bignum = require('bignumber');
var Router = require('../utils/router.js');
var slots = require('../utils/slots.js')
var sandboxHelper = require('../utils/sandbox.js');
var LimitCache = require('../utils/limit-cache.js');
var shell = require('../utils/shell.js');

// Private fields
var modules, library, self, private = {}, shared = {};

private.headers = {};
private.loaded = false;
private.messages = {};
private.invalidTrsCache = new LimitCache()

// Constructor
function Transport(cb, scope) {
  library = scope;
  self = this;
  self.__private = private;
  private.attachApi();

  setImmediate(cb, null, self);
}

// Private methods
private.attachApi = function () {
  var router = new Router();

  router.use(function (req, res, next) {
    if (modules && private.loaded && !modules.loader.syncing()) return next();
    res.status(500).send({ success: false, error: "Blockchain is loading" });
  });

  router.use(function (req, res, next) {
    var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (!peerIp) {
      return res.status(500).send({ success: false, error: "Wrong header data" });
    }

    req.headers['port'] = parseInt(req.headers['port']);

    req.sanitize(req.headers, {
      type: "object",
      properties: {
        os: {
          type: "string",
          maxLength: 64
        },
        'magic': {
          type: 'string',
          maxLength: 8
        },
        'version': {
          type: 'string',
          maxLength: 11
        }
      },
      required: ['magic', 'version']
    }, function (err, report, headers) {
      if (err) return next(err);
      if (!report.isValid) return res.status(500).send({ success: false, error: report.issues });

      if (req.headers['magic'] !== library.config.magic) {
        return res.status(500).send({
          success: false,
          error: "Request is made on the wrong network",
          expected: library.config.magic,
          received: req.headers['magic']
        });
      }
      // if (peerIp == "127.0.0.1") {
      //   return next();
      // }
      if (!req.headers.version) {
        return next();
      }
      var peer = {
        ip: ip.toLong(peerIp),
        port: headers.port,
        state: 2,
        os: headers.os,
        version: headers.version
      };

      if (req.body && req.body.chain) {
        peer.chain = req.body.chain;
      }

      if (peer.port && peer.port > 0 && peer.port <= 65535) {
        if (modules.peer.isCompatible(peer.version)) {
          peer.version && modules.peer.update(peer);
        } else {
          return res.status(500).send({
            success: false,
            error: "Version is not comtibleVersion"
          });
        }
      }

      next();
    });

  });

  router.get('/list', function (req, res) {
    res.set(private.headers);
    modules.peer.listWithChain({ limit: 100 }, function (err, peers) {
      return res.status(200).json({ peers: !err ? peers : [] });
    })
  });

  router.get("/blocks/common", function (req, res, next) {
    res.set(private.headers);

    req.sanitize(req.query, {
      type: "object",
      properties: {
        max: {
          type: 'integer'
        },
        min: {
          type: 'integer'
        },
        ids: {
          type: 'string',
          format: 'splitarray'
        }
      },
      required: ['max', 'min', 'ids']
    }, function (err, report, query) {
      if (err) return next(err);
      if (!report.isValid) return res.json({ success: false, error: report.issue });


      var max = query.max;
      var min = query.min;
      var ids = query.ids.split(",");
      (async () => {
        let query = req.query
        try {
          let blocks = await app.model.Block.findAll({
            condition: {
              id: {
                $in: ids
              },
              height: { $between: [query.min, query.max] }
            },
            sort: {
              height: 1
            },
          })
          app.logger.debug('find common blocks in database', blocks)
          if (!blocks || !blocks.length) {
            return res.json({ success: false, error: 'Common block not found' })
          }
          return res.json({ success: true, common: blocks[blocks.length - 1] });
        } catch (e) {
          app.logger.error('Failed to find common block: ' + e)
          return res.json({ success: false, error: 'Failed to find common block' })
        }
      })()
    });
  });

  router.get("/blocks", function (req, res) {
    res.set(private.headers);

    req.sanitize(req.query, {
      type: 'object',
      properties: { lastBlockId: { type: 'string' } }
    }, function (err, report, query) {
      if (err) return next(err);
      if (!report.isValid) return res.json({ success: false, error: report.issues });

      var blocksLimit = 200;
      if (query.limit) {
        blocksLimit = Math.min(blocksLimit, Number(query.limit))
      }

      (async function () {
        let lastBlockId = req.query.lastBlockId
        res.status(200);
        try {
          let lastBlock = await app.model.Block.findOne({ condition: { id: lastBlockId } })
          if (!lastBlock) throw new Error('Last block not found: ' + lastBlockId)

          let blocks = await app.model.Block.findAll({
            condition: {
              height: { $gt: lastBlock.height }
            },
            limit: blocksLimit,
            sort: { height: 1 }
          })
          if (!blocks || !blocks.length) return res.json({ blocks: [] })

          let maxHeight = blocks[blocks.length - 1].height
          let transactions = await app.model.Transaction.findAll({
            condition: {
              height: { $gt: lastBlock.height, $lte: maxHeight }
            }
          })
          app.logger.debug('Transport get blocks transactions', transactions)
          let firstHeight = blocks[0].height
          for (let i in transactions) {
            let t = transactions[i]
            let h = t.height
            let b = blocks[h - firstHeight]
            if (!!b) {
              if (!b.transactions) {
                b.transactions = []
              }
              b.transactions.push(t)
            }
          }
          res.json({ blocks: blocks });
        } catch (e) {
          app.logger.error('Failed to get blocks or transactions', e)
          return res.json({ blocks: "" });
        }
      })()
    });
  });

  router.post("/blocks", function (req, res) {
    res.set(private.headers);

    var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    var peerStr = peerIp ? peerIp + ":" + (isNaN(parseInt(req.headers['port'])) ? 'unkwnown' : parseInt(req.headers['port'])) : 'unknown';
    if (typeof req.body.block == 'string') {
      req.body.block = library.protobuf.decodeBlock(new Buffer(req.body.block, 'base64'));
    }
    if (typeof req.body.votes == 'string') {
      req.body.votes = library.protobuf.decodeBlockVotes(new Buffer(req.body.votes, 'base64'));
    }
    try {
      var block = library.base.block.objectNormalize(req.body.block);
      var votes = library.base.consensus.normalizeVotes(req.body.votes);
    } catch (e) {
      library.logger.log('normalize block or votes object error: ' + e.toString());
      library.logger.log('Block ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peerStr);

      if (peerIp && req.headers['port'] > 0 && req.headers['port'] < 65536) {
        modules.peer.state(ip.toLong(peerIp), parseInt(req.headers['port']), 0, 3600);
      }

      return res.sendStatus(200);
    }

    library.bus.message('receiveBlock', block, votes);
    res.sendStatus(200);
  });

  router.post("/votes", function (req, res) {
    res.set(private.headers);

    library.scheme.validate(req.body, {
      type: "object",
      properties: {
        height: {
          type: "integer",
          minimum: 1
        },
        id: {
          type: "string",
          maxLength: 64,
        },
        signatures: {
          type: "array",
          minLength: 1,
          maxLength: 101,
        }
      },
      required: ["height", "id", "signatures"]
    }, function (err) {
      if (err) {
        return res.status(200).json({ success: false, error: "Schema validation error" });
      }
      library.bus.message('receiveVotes', req.body);
      res.sendStatus(200);
    });
  });

  router.post("/propose", function (req, res) {
    res.set(private.headers);
    if (typeof req.body.propose == 'string') {
      req.body.propose = library.protobuf.decodeBlockPropose(new Buffer(req.body.propose, 'base64'));
    }
    library.scheme.validate(req.body.propose, {
      type: "object",
      properties: {
        height: {
          type: "integer",
          minimum: 1
        },
        id: {
          type: "string",
          maxLength: 64,
        },
        timestamp: {
          type: "integer"
        },
        generatorPublicKey: {
          type: "string",
          format: "publicKey"
        },
        address: {
          type: "string"
        },
        hash: {
          type: "string",
          format: "hex"
        },
        signature: {
          type: "string",
          format: "signature"
        }
      },
      required: ["height", "id", "timestamp", "generatorPublicKey", "address", "hash", "signature"]
    }, function (err) {
      if (err) {
        return res.status(200).json({ success: false, error: "Schema validation error" });
      }
      library.bus.message('receivePropose', req.body.propose);
      res.sendStatus(200);
    });
  });

  router.post('/signatures', function (req, res) {
    res.set(private.headers);

    library.scheme.validate(req.body, {
      type: "object",
      properties: {
        signature: {
          type: "object",
          properties: {
            transaction: {
              type: "string"
            },
            signature: {
              type: "string",
              format: "signature"
            }
          },
          required: ['transaction', 'signature']
        }
      },
      required: ['signature']
    }, function (err) {
      if (err) {
        return res.status(200).json({ success: false, error: "Validation error" });
      }

      modules.multisignatures.processSignature(req.body.signature, function (err) {
        if (err) {
          return res.status(200).json({ success: false, error: "Process signature error" });
        } else {
          return res.status(200).json({ success: true });
        }
      });
    });
  });

  router.get('/signatures', function (req, res) {
    res.set(private.headers);

    var unconfirmedList = modules.transactions.getUnconfirmedTransactionList();
    var signatures = [];

    async.eachSeries(unconfirmedList, function (trs, cb) {
      if (trs.signatures && trs.signatures.length) {
        signatures.push({
          transaction: trs.id,
          signatures: trs.signatures
        });
      }

      setImmediate(cb);
    }, function () {
      return res.status(200).json({ success: true, signatures: signatures });
    });
  });

  router.get("/transactions", function (req, res) {
    res.set(private.headers);
    // Need to process headers from peer
    res.status(200).json({ transactions: modules.transactions.getUnconfirmedTransactionList() });
  });

  router.post("/transactions", function (req, res) {
    var lastBlock = modules.blocks.getLastBlock();
    var lastSlot = slots.getSlotNumber(lastBlock.timestamp);
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error("OS INFO", shell.getInfo())
      library.logger.error("Blockchain is not ready", { getNextSlot: slots.getNextSlot(), lastSlot: lastSlot, lastBlockHeight: lastBlock.height })
      return res.status(200).json({ success: false, error: "Blockchain is not ready" });
    }

    res.set(private.headers);

    var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    var peerStr = peerIp ? peerIp + ":" + (isNaN(req.headers['port']) ? 'unknown' : req.headers['port']) : 'unknown';
    if (typeof req.body.transaction == 'string') {
      req.body.transaction = library.protobuf.decodeTransaction(new Buffer(req.body.transaction, 'base64'));
    }
    try {
      var transaction = library.base.transaction.objectNormalize(req.body.transaction);
      // transaction.asset = transaction.asset || {}
    } catch (e) {
      library.logger.error("transaction parse error", {
        raw: req.body,
        trs: transaction,
        error: e.toString()
      });
      library.logger.log('Received transaction ' + (transaction ? transaction.id : 'null') + ' is not valid, ban 60 min', peerStr);

      if (peerIp && req.headers['port'] > 0 && req.headers['port' < 65536]) {
        modules.peer.state(ip.toLong(peerIp), req.headers['port'], 0, 3600);
      }

      return res.status(200).json({ success: false, error: "Invalid transaction body" });
    }

    if (private.invalidTrsCache.has(transaction.id)) {
      return res.status(200).json({ success: false, error: "Already processed transaction" + transaction.id });
    }

    library.sequence.add(function (cb) {
      if (modules.transactions.hasUnconfirmed(transaction)) {
        return cb('Already exists');
      }
      library.logger.log('Received transaction ' + transaction.id + ' from peer ' + peerStr);
      modules.transactions.receiveTransactions([transaction], cb);
    }, function (err, transactions) {
      if (err) {
        library.logger.warn('Receive invalid transaction,id is ' + transaction.id, err);
        private.invalidTrsCache.set(transaction.id, true)
        let errMsg = err.message ? err.message : err.toString()
        res.status(200).json({ success: false, error: errMsg });
      } else {
        library.bus.message('unconfirmedTransaction', transaction, true);
        res.status(200).json({ success: true, transactionId: transactions[0].id });
      }
    });
  });

  router.get('/height', function (req, res) {
    res.set(private.headers);
    res.status(200).json({
      height: modules.blocks.getLastBlock().height
    });
  });

  router.post("/chain/message", function (req, res) {
    res.set(private.headers);

    try {
      if (!req.body.chain) {
        return res.status(200).json({ success: false, error: "missed chain" });
      }
      if (!req.body.timestamp || !req.body.hash) {
        return res.status(200).json({
          success: false,
          error: "missed hash sum"
        });
      }
      var newHash = private.hashsum(req.body.body, req.body.timestamp);
      if (newHash !== req.body.hash) {
        return res.status(200).json({ success: false, error: "wrong hash sum" });
      }
    } catch (e) {
      return res.status(200).json({ success: false, error: e.toString() });
    }

    if (private.messages[req.body.hash]) {
      return res.sendStatus(200);
    }

    private.messages[req.body.hash] = true;
    modules.chains.message(req.body.chain, req.body.body, function (err, body) {
      if (!err && body.error) {
        err = body.error;
      }

      if (err) {
        return res.status(200).json({ success: false, error: err });
      }

      library.bus.message('message', req.body, true);
      res.status(200).json(extend({}, body, { success: true }));
    });
  });

  router.post("/chain/request", function (req, res) {
    res.set(private.headers);

    try {
      if (!req.body.chain) {
        return res.status(200).json({ success: false, error: "missed chain" });
      }
      if (!req.body.timestamp || !req.body.hash) {
        return res.status(200).json({
          success: false,
          error: "missed hash sum"
        });
      }
      var newHash = private.hashsum(req.body.body, req.body.timestamp);
      if (newHash !== req.body.hash) {
        return res.status(200).json({ success: false, error: "wrong hash sum" });
      }
    } catch (e) {
      return res.status(200).json({ success: false, error: e.toString() });
    }

    modules.chains.request(req.body.chain, req.body.body.method, req.body.body.path, { query: req.body.body.query }, function (err, body) {
      if (!err && body.error) {
        err = body.error;
      }

      if (err) {
        return res.status(200).json({ success: false, error: err });
      }
      res.status(200).json(extend({}, { success: true }, body));
    });
  });

  router.post("/chainReady", function (req, res) {
    res.set(private.headers);

    library.scheme.validate(req.body, {
      type: "object",
      properties: {
        chain: {
          type: "string",
          length: 64
        }
      },
      required: ["chain"]
    }, function (err) {
      if (err) {
        return res.status(200).json({ success: false, error: "Schema validation error" });
      }
      res.sendStatus(200);
    });
  });

  router.use(function (req, res, next) {
    res.status(500).send({ success: false, error: "API endpoint not found" });
  });

  library.network.app.use('/peer', router);

  library.network.app.use(function (err, req, res, next) {
    if (!err) return next();
    library.logger.error(req.url, err.toString());
    res.status(500).send({ success: false, error: err.toString() });
  });
}

private.hashsum = function (obj) {
  var buf = new Buffer(JSON.stringify(obj), 'utf8');
  var hashdig = crypto.createHash('sha256').update(buf).digest();
  var temp = new Buffer(8);
  for (var i = 0; i < 8; i++) {
    temp[i] = hashdig[7 - i];
  }

  return bignum.fromBuffer(temp).toString();
}

Transport.prototype.broadcast = function (config, options, cb) {
  config.limit = 20;
  modules.peer.list(config, function (err, peers) {
    if (!err) {
      async.eachLimit(peers, 5, function (peer, cb) {
        self.getFromPeer(peer, options);

        setImmediate(cb);
      }, function () {
        cb && cb(null, { body: null, peer: peers });
      })
    } else {
      cb && setImmediate(cb, err);
    }
  });
}

Transport.prototype.getFromRandomPeer = function (config, options, cb) {
  if (typeof options == 'function') {
    cb = options;
    options = config;
    config = {};
  }
  config.limit = 1;
  modules.peer.list(config, function (err, peers) {
    if (!err && peers.length) {
      var peer = peers[0];
      self.getFromPeer(peer, options, cb);
    } else {
      modules.peer.reset()
      return cb(err || "No peers in db");
    }
  });
  // async.retry(20, function (cb) {

  // }, function (err, results) {
  //   cb(err, results)
  // });
}

/**
 * Send request to selected peer
 * @param {object} peer Peer object
 * @param {object} options Request lib params with special value `api` which should be string name of peer's module
 * web method
 * @param {function} cb Result Callback
 * @returns {*|exports} Request lib request instance
 * @private
 * @example
 *
 * // Send gzipped request to peer's web method /peer/blocks.
 * .getFromPeer(peer, { api: '/blocks', gzip: true }, function (err, data) {
 *  // Process request
 * });
 */
Transport.prototype.getFromPeer = function (peer, options, cb) {
  var url;
  if (options.api) {
    url = '/peer' + options.api
  } else {
    url = options.url;
  }
  if (peer.address) {
    url = 'http://' + peer.address + url;

  } else {
    url = 'http://' + ip.fromLong(peer.ip) + ':' + peer.port + url;
  }
  var req = {
    url: url,
    method: options.method,
    json: true,
    headers: extend({}, private.headers, options.headers),
    timeout: library.config.peers.options.timeout,
    forever: true
  };
  if (Object.prototype.toString.call(options.data) === "[object Object]" || util.isArray(options.data)) {
    req.json = options.data;
  } else {
    req.body = options.data;
  }

  return request(req, function (err, response, body) {
    if (err || response.statusCode != 200) {
      library.logger.debug('Request', {
        url: req.url,
        statusCode: response ? response.statusCode : 'unknown',
        err: err
      });

      if (peer) {
        // TODO use ban instead of remove
        if (err && (err.code == "ETIMEDOUT" || err.code == "ESOCKETTIMEDOUT" || err.code == "ECONNREFUSED")) {
          modules.peer.remove(peer.ip, peer.port, function (err) {
            if (!err) {
              library.logger.info('Removing peer ' + req.method + ' ' + req.url)
            }
          });
        } else {
          if (!options.not_ban) {
            modules.peer.state(peer.ip, peer.port, 0, 600, function (err) {
              if (!err) {
                library.logger.info('Ban 10 min ' + req.method + ' ' + req.url);
              }
            });
          }
        }
      }
      cb && cb(err || ('request status code' + response.statusCode), { body: body, peer: peer });
      return;
    }

    response.headers['port'] = parseInt(response.headers['port']);

    var report = library.scheme.validate(response.headers, {
      type: "object",
      properties: {
        os: {
          type: "string",
          maxLength: 64
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535
        },
        'magic': {
          type: "string",
          maxLength: 8
        },
        version: {
          type: "string",
          maxLength: 11
        }
      },
      required: ['port', 'magic', 'version']
    });

    if (!report) {
      return cb && cb(null, { body: body, peer: peer });
    }

    var port = response.headers['port'];
    var version = response.headers['version'];
    if (port > 0 && port <= 65535 && version == library.config.version) {
      modules.peer.update({
        ip: peer.ip,
        port: port,
        state: 2,
        os: response.headers['os'],
        version: version
      });
    } else if (!modules.peer.isCompatible(version)) {
      library.logger.debug("Remove uncompatible peer " + peer.ip, version);
      modules.peer.remove(peer.ip, port);
    }

    cb && cb(null, { body: body, peer: peer });
  });
}

Transport.prototype.sandboxApi = function (call, args, cb) {
  sandboxHelper.callMethod(shared, call, args, cb);
}

// Events
Transport.prototype.onBind = function (scope) {
  modules = scope;

  private.headers = {
    os: modules.system.getOS(),
    version: modules.system.getVersion(),
    port: modules.system.getPort(),
    magic: modules.system.getMagic()
  }
}

Transport.prototype.onBlockchainReady = function () {
  private.loaded = true;
}

Transport.prototype.onSignature = function (signature, broadcast) {
  if (broadcast) {
    self.broadcast({}, { api: '/signatures', data: { signature: signature }, method: "POST" });
    library.network.io.sockets.emit('signature/change', {});
  }
}

Transport.prototype.onUnconfirmedTransaction = function (transaction, broadcast) {
  if (broadcast) {
    var data = {
      // transaction: library.protobuf.encodeTransaction(transaction).toString('base64')
      transaction: transaction
    };
    self.broadcast({}, { api: '/transactions', data: data, method: "POST" });
    library.network.io.sockets.emit('transactions/change', {});
  }
}

Transport.prototype.onNewBlock = function (block, votes, broadcast) {
  if (broadcast) {
    // var data = {
    //   block: library.protobuf.encodeBlock(block).toString('base64'),
    //   votes: library.protobuf.encodeBlockVotes(votes).toString('base64'),
    // };
    let data = { block: block, votes: votes }
    self.broadcast({}, { api: '/blocks', data: data, method: "POST" });
    library.network.io.sockets.emit('blocks/change', {});
  }
}

Transport.prototype.onNewPropose = function (propose, broadcast) {
  if (broadcast) {
    var data = {
      propose: library.protobuf.encodeBlockPropose(propose).toString('base64')
    };
    self.broadcast({}, { api: '/propose', data: data, method: "POST" });
  }
}

Transport.prototype.onChainReady = function (chain, broadcast) {
  if (broadcast) {
    var data = {
      chain: chain 
    }
    self.broadcast({}, { api: '/chainReady', data: data, method: "POST" })
  }
}

Transport.prototype.sendVotes = function (votes, address) {
  self.getFromPeer({ address: address }, {
    api: '/votes',
    data: votes,
    method: "POST"
  });
}

Transport.prototype.onMessage = function (msg, broadcast) {
  if (broadcast) {
    self.broadcast({ chain: msg.chain }, { api: '/chain/message', data: msg, method: "POST" });
  }
}

Transport.prototype.cleanup = function (cb) {
  private.loaded = false;
  cb();
}

// Shared
shared.message = function (msg, cb) {
  msg.timestamp = (new Date()).getTime();
  msg.hash = private.hashsum(msg.body, msg.timestamp);

  self.broadcast({ chain: msg.chain }, { api: '/chain/message', data: msg, method: "POST" });

  cb(null, {});
}

shared.request = function (msg, cb) {
  msg.timestamp = (new Date()).getTime();
  msg.hash = private.hashsum(msg.body, msg.timestamp);

  if (msg.body.peer) {
    self.getFromPeer(msg.body.peer, {
      api: '/chain/request',
      data: msg,
      method: "POST"
    }, cb);
  } else {
    self.getFromRandomPeer({ chain: msg.chain }, { api: '/chain/request', data: msg, method: "POST" }, cb);
  }
}

// Export
module.exports = Transport;
