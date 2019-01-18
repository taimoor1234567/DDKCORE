const _ = require('lodash');
const async = require('async');
const constants = require('../../helpers/constants.js');
const schema = require('../../schema/blocks.js');
const slots = require('../../helpers/slots.js');
const sql = require('../../sql/blocks.js');

let modules;
let library;
let self;
const __private = {};

/**
 * Initializes library.
 * @memberof module:blocks
 * @class
 * @classdesc Main Process logic.
 * Allows process blocks.
 * @param {Object} logger
 * @param {Block} block
 * @param {Peers} peers
 * @param {Transaction} transaction
 * @param {ZSchema} schema
 * @param {Database} db
 * @param {Sequence} dbSequence
 * @param {Sequence} sequence
 * @param {Object} genesisblock
 */
function Process(logger, block, peers, transaction, Schema, db, dbSequence, sequence, genesisblock) {
    library = {
        logger,
        schema: Schema,
        db,
        dbSequence,
        sequence,
        genesisblock,
        logic: {
            block,
            peers,
            transaction,
        },
    };
    self = this;

    library.logger.trace('Blocks->Process: Submodule initialized.');
    return self;
}

/**
 * Performs chain comparison with remote peer
 * WARNING: Can trigger chain recovery
 *
 * @async
 * @public
 * @method getCommonBlock
 * @param  {Peer}     peer Peer to perform chain comparison with
 * @param  {number}   height Block height
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.res Result object
 */
Process.prototype.getCommonBlock = function (peer, height, cb) {
    let comparisionFailed = false;

    async.waterfall([
        function (waterCb) {
            // Get IDs sequence (comma separated list)
            modules.blocks.utils.getIdSequence(height, (err, res) => setImmediate(waterCb, err, res));
        },
        function (res, waterCb) {
            const ids = res.ids;

            // Perform request to supplied remote peer
            modules.transport.getFromPeer(peer, {
                api: `/blocks/common?ids=${ids}`,
                method: 'GET'
            }, (err, result) => {
                if (err || result.body.error) {
                    return setImmediate(waterCb, err || result.body.error.toString());
                } else if (!result.body.common) {
                    // FIXME: Need better checking here, is base on 'common' property enough?
                    comparisionFailed = true;
                    return setImmediate(
                        waterCb,
                        ['Chain comparison failed with peer:', peer.string, 'using ids:', ids].join(' ')
                    );
                }
                return setImmediate(waterCb, null, result);
            });
        },
        function (res, waterCb) {
            // Validate remote peer response via schema
            const common = res.body.common;
            if (common && common.height === 1) {
                comparisionFailed = true;
                return setImmediate(
                    waterCb,
                    'Comparison failed - received genesis as common block'
                );
            }

            library.schema.validate(common, schema.getCommonBlock, (err) => {
                if (err) {
                    return setImmediate(waterCb, err[0].message);
                }
                return setImmediate(waterCb, null, res);
            });
        },
        function (res, waterCb) {
            // Check that block with ID, previousBlock and height exists in database
            library.db.query(sql.getCommonBlock(res.body.common.previousBlock), {
                id: res.body.common.id,
                previousBlock: res.body.common.previousBlock,
                height: res.body.common.height
            })
                .then((rows) => {
                    if (!rows.length || !rows[0].count) {
                        // Block doesn't exists - comparison failed
                        comparisionFailed = true;
                        return setImmediate(
                            waterCb,
                            [
                                'Chain comparison failed with peer:',
                                peer.string,
                                'using block:',
                                JSON.stringify(res.body.common)
                            ].join(' ')
                        );
                    }
                    // Block exists - it's common between our node and remote peer
                    return setImmediate(waterCb, null, res.body.common);
                })
                .catch((err) => {
                    // SQL error occurred
                    library.logger.error(err.stack);
                    return setImmediate(waterCb, 'Blocks#getCommonBlock error');
                });
        }
    ], (err, res) => {
        // If comparison failed and current consensus is low - perform chain recovery
        /*
         * Removed poor consensus check in order to sync data
         */
        if (comparisionFailed && modules.transport.poorConsensus()) {
            return modules.blocks.chain.recoverChain(cb);
        }
        return setImmediate(cb, err, res);
    });
};


/**
 * Loads full blocks from database, used when rebuilding blockchain, snapshotting
 * see: loader.loadBlockChain (private)
 *
 * @async
 * @public
 * @method loadBlocksOffset
 * @param  {number}   limit Limit amount of blocks
 * @param  {number}   offset Offset to start at
 * @param  {boolean}  verify Indicator that block needs to be verified
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.lastBlock Current last block
 */
Process.prototype.loadBlocksOffset = function (limit, offset, verify, cb) {
    // Calculate limit if offset is supplied
    const newLimit = limit + (offset || 0);
    const params = { limit: newLimit, offset: offset || 0 };

    library.logger.debug('Loading blocks offset', { limit, offset, verify });
    // Execute in sequence via dbSequence
    library.dbSequence.add((cbAdd) => {
        // Loads full blocks from database
        // FIXME: Weird logic in that SQL query, also ordering used can be performance bottleneck - to rewrite
        library.db.query(sql.loadBlocksOffset, params)
            .then((rows) => {
                // Normalize blocks
                const blocks = modules.blocks.utils.readDbRows(rows);

                async.eachSeries(blocks, (block, cbBlocks) => {
                    // Stop processing if node shutdown was requested
                    if (modules.blocks.isCleaning.get()) {
                        return setImmediate(cbBlocks);
                    }

                    library.logger.debug('Processing block', block.id);

                    if (block.id === library.genesisblock.block.id) {
                        modules.blocks.chain.newApplyGenesisBlock(block, false, false)
                            .then(() => setImmediate(cbBlocks));
                    } else {
                        return modules.blocks.verify.processBlock(
                            block,
                            false,
                            false,
                            verify,
                            (err) => {
                                if (err) {
                                    library.logger.debug('Block processing failed', {
                                        id: block.id,
                                        err: err.toString(),
                                        module: 'blocks',
                                        block,
                                    });
                                }
                                // Update last block
                                // modules.blocks.lastBlock.push(block);
                                return setImmediate(cbBlocks, err);
                            }
                        );
                    }
                }, err => setImmediate(cbAdd, err, modules.blocks.lastBlock.get()));
            })
            .catch((err) => {
                library.logger.error(err.stack);
                return setImmediate(cbAdd, 'Blocks#loadBlocksOffset error');
            });
    }, cb);
};

/**
 * Ask remote peer for blocks and process them
 *
 * @async
 * @public
 * @method loadBlocksFromPeer
 * @param  {Peer}     peer Peer to perform chain comparison with
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.lastValidBlock Normalized new last block
 */
Process.prototype.loadBlocksFromPeer = function (peer, cb) {
    // Set current last block as last valid block
    let lastValidBlock = modules.blocks.lastBlock.get();

    // Normalize peer
    peer = library.logic.peers.create(peer);
    library.logger.info(`Loading blocks from: ${peer.string}`);

    function getFromPeer(seriesCb) {
        // Ask remote peer for blocks
        modules.transport.getFromPeer(peer, {
            method: 'GET',
            api: `/blocks?lastBlockId=${lastValidBlock.id}`
        }, (err, res) => {
            err = err || res.body.error;
            if (err) {
                return setImmediate(seriesCb, err);
            }
            return setImmediate(seriesCb, null, res.body.blocks);
        });
    }

    // Validate remote peer response via schema
    function validateBlocks(blocks, seriesCb) {
        const report = library.schema.validate(blocks, schema.loadBlocksFromPeer);

        if (!report) {
            return setImmediate(seriesCb, 'Received invalid blocks data');
        }
        return setImmediate(seriesCb, null, blocks);
    }

    // Process single block
    function processBlock(block, seriesCb) {
        // Start block processing - broadcast: false, saveBlock: true
        modules.transactions.removeFromPool(block.transactions, true).then(
            async (removedTransactions) => {
                try {
                    modules.transactions.lockTransactionPoolAndQueue();
                    await modules.blocks.verify.newProcessBlock(block, false, true, true, true);
                    lastValidBlock = block;
                    library.logger.info(
                        ['Block', block.id, 'loaded from:', peer.string].join(' '),
                        `height: ${block.height}`
                    );

                    const transactionForReturn = [];
                    removedTransactions.forEach((removedTrs) => {
                        if (!(block.transactions.find(trs => trs.id === removedTrs.id))) {
                            transactionForReturn.push(removedTrs);
                        }
                    });
                    await modules.transactions.pushInPool(transactionForReturn);
                    await modules.transactions.returnToQueueConflictedTransactionFromPool();
                    modules.transactions.unlockTransactionPoolAndQueue();
                    return seriesCb();
                } catch (err) {
                    const id = (block ? block.id : 'null');
                    library.logger.debug(
                        'Block processing failed', { id, err: err.toString(), module: 'blocks', block }
                    );
                    await modules.transactions.pushInPool(removedTransactions);
                    modules.transactions.unlockTransactionPoolAndQueue();
                    return seriesCb(err);
                }
            }
        );
    }

    // Process all received blocks
    function processBlocks(blocks, seriesCb) {
        // Skip if ther is no blocks
        if (blocks.length === 0) {
            return setImmediate(seriesCb);
        }
        // Iterate over received blocks, normalize block first...
        async.eachSeries(modules.blocks.utils.readDbRows(blocks), (block, eachSeriesCb) => {
            if (modules.blocks.isCleaning.get()) {
                // Cancel processing if node shutdown was requested
                return setImmediate(eachSeriesCb);
            }
            // ...then process block
            return processBlock(block, (err) => {
                // Ban a peer if block validation fails
                // Invalid peers won't get chosen in the next sync attempt
                if (err) {
                    library.logic.peers.ban(peer);
                }
                return eachSeriesCb(err);
            });
        }, err => setImmediate(seriesCb, err));
    }

    async.waterfall([
        getFromPeer,
        validateBlocks,
        processBlocks
    ], (err) => {
        if (err) {
            return setImmediate(cb, `Error loading blocks: ${err.message || err}`, lastValidBlock);
        }
        return setImmediate(cb, null, lastValidBlock);
    });
};

/**
 * Generate new block
 * see: loader.loadBlockChain (private)
 *
 * @async
 * @public
 * @method generateBlock
 * @param  {Object}   keypair Pair of private and public keys, see: helpers.ed.makeKeypair
 * @param  {number}   timestamp Slot time, see: helpers.slots.getSlotTime
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error message if error occurred
 */
Process.prototype.generateBlock = function (keypair, timestamp, cb) {
    // Get transactions that will be included in block
    const transactions = modules.transactions.getUnconfirmedTransactionList(false, constants.maxTxsPerBlock);
    const ready = [];

    async.eachSeries(transactions, (transaction, cb) => {
        modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, (err, sender) => {
            if (err || !sender) {
                return setImmediate(cb, 'Sender not found');
            }

            // Check transaction depends on type
            if (library.logic.transaction.ready(transaction, sender)) {
                // Verify transaction
                library.logic.transaction.verify({
                    trs: transaction,
                    sender,
                    checkExists: true,
                    cb(error) {
                        if (!error) {
                            ready.push(transaction);
                        }
                        return setImmediate(cb, error);
                    },
                });
            } else {
                return setImmediate(cb, `Transaction ${transaction.id} not ready`);
            }
        });
    }, (err) => {
        if (err) {
            return setImmediate(cb, err);
        }
        let block;
        try {
            // Create a block
            block = library.logic.block.create({
                keypair,
                timestamp,
                previousBlock: modules.blocks.lastBlock.get(),
                transactions: ready
            });
        } catch (e) {
            library.logger.error(e.stack);
            return setImmediate(cb, e);
        }

        // Start block processing - broadcast: true, saveBlock: true
        modules.blocks.verify.processBlock(block, true, true, true, cb);
    });
};

Process.prototype.newGenerateBlock = async (keypair, timestamp) => {
    let block;
    const transactions = await modules.transactions.getUnconfirmedTransactionsForBlockGeneration();
    library.logger.debug(`[Process][newGenerateBlock][transactions] ${JSON.stringify(transactions)}`);

    modules.transactions.lockTransactionPoolAndQueue();

    try {
        block = library.logic.block.create({
            keypair,
            timestamp,
            previousBlock: modules.blocks.lastBlock.get(),
            transactions
        });
    } catch (e) {
        library.logger.error(`[Process][newGenerateBlock][create] ${e}`);
        library.logger.error(`[Process][newGenerateBlock][create][stack] ${e.stack}`);
        throw e;
    }

    try {
        await modules.blocks.verify.newProcessBlock(block, true, true, true, true);
        modules.transactions.unlockTransactionPoolAndQueue();
    } catch (e) {
        await modules.transactions.pushInPool(transactions);
        modules.transactions.unlockTransactionPoolAndQueue();
        library.logger.error(`[Process][newGenerateBlock][processBlock] ${e}`);
        library.logger.error(`[Process][newGenerateBlock][processBlock][stack] ${e.stack}`);
    }
};

/**
 * Validate if block generator is valid delegate.
 *
 * @private
 * @func validateBlockSlot
 * @param {Object} block - Current normalized block
 * @param {Object} lastBlock - Last normalized block
 * @param {Function} cb - Callback function
 */
__private.validateBlockSlot = function (block, lastBlock, cb) {
    const roundNextBlock = slots.calcRound(block.height);
    const roundLastBlock = slots.calcRound(lastBlock.height);
    const activeDelegates = modules.rounds.getSlotDelegatesCount(block.height);
    if (
        lastBlock.height % activeDelegates === 0 ||
        roundLastBlock < roundNextBlock
    ) {
        // Check if block was generated by the right active delagate from previous round.
        // DATABASE: Read only to mem_accounts to extract active delegate list
        modules.delegates.validateBlockSlotAgainstPreviousRound(block, err =>
            setImmediate(cb, err)
        );
    } else {
        // Check if block was generated by the right active delagate.
        // DATABASE: Read only to mem_accounts to extract active delegate list
        modules.delegates.validateBlockSlot(block, err => setImmediate(cb, err));
    }
};

/**
 * EVENTS
 */

/**
 * Handle newly received block
 *
 * @public
 * @method  onReceiveBlock
 * @listens module:transport~event:receiveBlock
 * @param   {block} block New block
 */
Process.prototype.onReceiveBlock = function (block) {
    let lastBlock;

    // Execute in sequence via sequence
    library.sequence.add((cb) => {
        // When client is not loaded, is syncing or round is ticking
        // Do not receive new blocks as client is not ready
        if (!__private.loaded || modules.loader.syncing() || modules.rounds.ticking()) {
            library.logger.debug(`[Process][onReceiveBlock] !__private.loaded ${!__private.loaded}`);
            library.logger.debug(`[Process][onReceiveBlock] syncing ${modules.loader.syncing()}`);
            library.logger.debug('Client not ready to receive block', block.id);
            return;
        }

        // Get the last block
        lastBlock = modules.blocks.lastBlock.get();

        // Detect sane block
        if (block.previousBlock === lastBlock.id && lastBlock.height + 1 === block.height) {
            __private.newReceiveBlock(block).then(() => setImmediate(cb, null));
        } else if (block.previousBlock !== lastBlock.id && lastBlock.height + 1 === block.height) {
            // Process received fork cause 1
            return __private.receiveForkOne(block, lastBlock, cb);
        } else if (
            block.previousBlock === lastBlock.previousBlock &&
            block.height === lastBlock.height && block.id !== lastBlock.id
        ) {
            // Process received fork cause 5
            return __private.receiveForkFive(block, lastBlock, cb);
        } else if (block.id === lastBlock.id) {
            library.logger.debug('Block already processed', block.id);
        } else {
            library.logger.warn([
                'Discarded block that does not match with current chain:', block.id,
                'height:', block.height,
                'round:', modules.rounds.calc(block.height),
                'slot:', slots.getSlotNumber(block.timestamp),
                'generator:', block.generatorPublicKey
            ].join(' '));
        }
        // Discard received block
        return setImmediate(cb);
    });
};

/**
 * Receive block - logs info about received block, updates last receipt, processes block
 *
 * @private
 * @async
 * @method receiveBlock
 * @param {Object}   block Full normalized block
 * @param {Function} cb Callback function
 */
__private.receiveBlock = function (block, cb) {
    library.logger.info([
        'Old Received new block id:', block.id,
        'height:', block.height,
        'round:', modules.rounds.calc(block.height),
        'slot:', slots.getSlotNumber(block.timestamp),
        'reward:', block.reward
    ].join(' '));

    // Update last receipt
    modules.blocks.lastReceipt.update();
    // Start block processing - broadcast: true, saveBlock: true
    modules.blocks.verify.processBlock(block, true, true, true, cb);
};


__private.newReceiveBlock = async (block) => {
    library.logger.info([
        'Received new block id:', block.id,
        'height:', block.height,
        'round:', modules.rounds.calc(block.height),
        'slot:', slots.getSlotNumber(block.timestamp),
        'reward:', block.reward
    ].join(' '));

    modules.blocks.lastReceipt.update();
    const removedTransactions = await modules.transactions.removeFromPool(block.transactions, true);

    try {
        modules.transactions.lockTransactionPoolAndQueue();

        await modules.blocks.verify.newProcessBlock(block, true, true, true, true);

        const transactionForReturn = [];
        removedTransactions.forEach((removedTrs) => {
            if (!(block.transactions.find(trs => trs.id === removedTrs.id))) {
                transactionForReturn.push(removedTrs);
            }
        });
        await modules.transactions.pushInPool(transactionForReturn);
        await modules.transactions.returnToQueueConflictedTransactionFromPool();
        modules.transactions.unlockTransactionPoolAndQueue();
    } catch (e) {
        await modules.transactions.pushInPool(removedTransactions);
        modules.transactions.unlockTransactionPoolAndQueue();
        library.logger.error(`[Process][newReceiveBlock] ${e}`);
        library.logger.error(`[Process][newReceiveBlock][stack] ${e.stack}`);
    }
};


/**
 * Receive block detected as fork cause 1: Consecutive height but different previous block id
 *
 * @private
 * @async
 * @method receiveBlock
 * @param {Object}   block Received block
 * @param {Function} cb Callback function
 */
__private.receiveForkOne = function (block, lastBlock, cb) {
    let tmpBlock = _.clone(block);

    // Fork: Consecutive height but different previous block id
    modules.delegates.fork(block, 1);

    // Keep the oldest block, or if both have same age, keep block with lower id
    if (block.timestamp > lastBlock.timestamp || (block.timestamp === lastBlock.timestamp && block.id > lastBlock.id)) {
        library.logger.info('Last block stands');
        return setImmediate(cb); // Discard received block
    }
    library.logger.info('Last block and parent loses');
    async.series([
        function (seriesCb) {
            try {
                tmpBlock = library.logic.block.objectNormalize(tmpBlock);
            } catch (err) {
                return setImmediate(seriesCb, err);
            }
            return setImmediate(seriesCb);
        },
        function (seriesCb) {
            __private.validateBlockSlot(tmpBlock, lastBlock, seriesCb);
        },
        // Check received block before any deletion
        function (seriesCb) {
            const check = modules.blocks.verify.verifyReceipt(tmpBlock);

            if (!check.verified) {
                library.logger.error(['Block', tmpBlock.id, 'verification failed'].join(' '), check.errors.join(', '));
                // Return first error from checks
                return setImmediate(seriesCb, check.errors[0]);
            }
            return setImmediate(seriesCb);
        },
        // Delete last 2 blocks
        modules.blocks.chain.deleteLastBlock,
        modules.blocks.chain.deleteLastBlock
    ], (err) => {
        if (err) {
            library.logger.error('Fork recovery failed', err);
        }
        return setImmediate(cb, err);
    });
};

/**
 * Receive block detected as fork cause 5: Same height and previous block id, but different block id
 *
 * @private
 * @async
 * @method receiveBlock
 * @param {Object}   block Received block
 * @param {Function} cb Callback function
 */
__private.receiveForkFive = function (block, lastBlock, cb) {
    let tmpBlock = _.clone(block);

    // Fork: Same height and previous block id, but different block id
    modules.delegates.fork(block, 5);

    // Check if delegate forged on more than one node
    if (block.generatorPublicKey === lastBlock.generatorPublicKey) {
        library.logger.warn('Delegate forging on multiple nodes', block.generatorPublicKey);
    }

    // Keep the oldest block, or if both have same age, keep block with lower id
    if (block.timestamp > lastBlock.timestamp || (block.timestamp === lastBlock.timestamp && block.id > lastBlock.id)) {
        library.logger.info('Last block stands');
        return setImmediate(cb); // Discard received block
    }
    library.logger.info('Last block loses');
    async.series([
        function (seriesCb) {
            try {
                tmpBlock = library.logic.block.objectNormalize(tmpBlock);
            } catch (err) {
                return setImmediate(seriesCb, err);
            }
            return setImmediate(seriesCb);
        },
        function (seriesCb) {
            __private.validateBlockSlot(tmpBlock, lastBlock, seriesCb);
        },
        // Check received block before any deletion
        function (seriesCb) {
            const check = modules.blocks.verify.verifyReceipt(tmpBlock);

            if (!check.verified) {
                library.logger.error(['Block', tmpBlock.id, 'verification failed'].join(' '), check.errors.join(', '));
                // Return first error from checks
                return setImmediate(seriesCb, check.errors[0]);
            }
            return setImmediate(seriesCb);
        },
        // Delete last block
        function (seriesCb) {
            modules.blocks.chain.deleteLastBlock(seriesCb);
        },
        // Process received block
        function (seriesCb) {
            return __private.newReceiveBlock(block).then(seriesCb);
        }
    ], (err) => {
        if (err) {
            library.logger.error('Fork recovery failed', err);
        }
        return setImmediate(cb, err);
    });
};

/**
 * Handle modules initialization
 * - accounts
 * - blocks
 * - delegates
 * - loader
 * - rounds
 * - transactions
 * - transport
 * @param {modules} scope Exposed modules
 */
Process.prototype.onBind = function (scope) {
    library.logger.trace('Blocks->Process: Shared modules bind.');
    modules = {
        accounts: scope.accounts,
        blocks: scope.blocks,
        delegates: scope.delegates,
        loader: scope.loader,
        rounds: scope.rounds,
        transactions: scope.transactions,
        transport: scope.transport,
    };

    // Set module as loaded
    __private.loaded = true;
};

module.exports = Process;

/** ************************************* END OF FILE ************************************ */
