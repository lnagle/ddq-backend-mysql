"use strict";

const EMIT_DATA = "data", EMIT_ERR = "error";

module.exports = (backendConfig, configValidation, crypto, EventEmitter, mysql, timers) => {
    /**
     * Updates heartbeatDate of specific record, logs an error if there is one,
     * and calls callback that is passed in. This will continue until
     * pausePolling is called.
     *
     * @param {Object} ddqBackendInstance
     * @param {string} recordId
     * @param {Function} callback
     */
    function heartbeat(ddqBackendInstance, recordId, callback) {
        ddqBackendInstance.connection.query(`UPDATE ??
            SET heartbeatDate = NOW()
            WHERE hash = ?
            AND isProcessing = true
            AND owner = ?;`,
            [
                ddqBackendInstance.config.table,
                recordId,
                ddqBackendInstance.owner
            ],
            (err) => {
                if (err) {
                    console.error(err);
                }

                callback(err);
            }
        );
    }


    /**
     * Polls for a random record with the minimum delay defined by the
     * config.pollDelayMs.
     *
     * @param {Object} ddqBackendInstance
     * @param {Function} callback
     */
    function poll(ddqBackendInstance, callback) {
        /**
         * Polls for a random record in the database and calls the callback
         * provided to it. This will continue until pausePolling is called.
         */
        function findData() {
            ddqBackendInstance.connection.query(`SELECT hash
                FROM ??
                WHERE isProcessing = false
                AND topics IN (?)
                OR topics IS NULL
                ORDER BY RAND()
                LIMIT 1;`,
                [
                    ddqBackendInstance.config.table,
                    ddqBackendInstance.config.topics
                ],
                callback
            );

            ddqBackendInstance.poller = timers.setTimeout(findData, ddqBackendInstance.config.pollDelayMs);
        }

        ddqBackendInstance.poller = timers.setTimeout(findData, ddqBackendInstance.config.pollDelayMs);
    }


    /**
     * Updates a specific record so that it can be requeued.
     *
     * @param {Object} ddqBackendInstance
     * @param {string} recordId
     * @param {Function} callback
     */
    function requeue(ddqBackendInstance, recordId, callback) {
        ddqBackendInstance.connection.query(`UPDATE ??
            SET owner = null, isProcessing = false, requeued = true
            WHERE hash = ?;`,
            [
                ddqBackendInstance.config.table,
                recordId
            ],
            callback
        );
    }


    /**
     * Deletes a specific record from the database. If unsuccessful, this
     * will call the command to requeue the record.
     *
     * @param {Object} ddqBackendInstance
     * @param {string} recordId
     */
    function remove(ddqBackendInstance, recordId) {
        ddqBackendInstance.connection.query(`DELETE FROM ??
            WHERE hash = ?
            AND requeued = false;`,
            [
                ddqBackendInstance.config.table,
                recordId
            ],
            (err) => {
                if (err) {
                    console.error("Error deleting record with id:", recordId);
                    console.error("Attempting requeue");
                    requeue(ddqBackendInstance, recordId, (requeueErr) => {
                        ddqBackendInstance.emit(EMIT_ERR, requeueErr);
                    });
                }
            }
        );
    }


    /**
     * Ensures that heartbeatCleanup is ready to run according to the
     * heartbeatCleanupDelay.
     *
     * @param {Object} ddqBackendInstance
     */
    function restore(ddqBackendInstance) {
        /**
         * Queries for jobs that have stopped, and primes them to be cleaned up.
         */
        function heartbeatCleanup() {
            ddqBackendInstance.connection.query(`UPDATE ??
                SET isProcessing = false, owner = null, requeued = false
                WHERE DATEDIFF(NOW(), SEC_TO_TIME(?)) > heartbeatDate
                AND isProcessing = true;`,
                [
                    ddqBackendInstance.config.table,
                    ddqBackendInstance.config.heartbeatLifetimeSeconds
                ],
                (err) => {
                    if (err) {
                        ddqBackendInstance.emit(EMIT_ERR, err);
                    }
                }
            );

            ddqBackendInstance.restorer = timers.setTimeout(heartbeatCleanup,
            ddqBackendInstance.heartbeatCleanupDelayMs);
        }

        ddqBackendInstance.restorer = timers.setTimeout(heartbeatCleanup,
            ddqBackendInstance.heartbeatCleanupDelayMs);
    }


    /**
     * Class for the ddqBackendMySql. Inherits from EventEmitter.
     */
    class DdqBackendMySql extends EventEmitter {
        /**
         * Default DdqBackendMySql properties.
         *
         * @param {Object} backendConfig
         */
        constructor() {
            configValidation.validateConfig(backendConfig);
            super();
            this.config = backendConfig;
            this.connection = null;
            this.currentlyPolling = false;
            this.owner = crypto.randomBytes(64).toString("hex");
            this.poller = null;
            this.restorer = null;
            this.topics = backendConfig.topics;
        }


        /**
         * Queries the database to get a random record. Returns that random
         * record along with methods to handle it.
         */
        checkNow() {
            var wrappedMessage;

            this.connection.query(`SELECT *
                FROM ??
                WHERE topics IN (?)
                OR topics IS NULL
                ORDER BY RAND()
                LIMIT 1;`,
                [
                    this.config.table,
                    this.config.topics
                ],
                (err, record) => {
                    if (err) {
                        this.emit(EMIT_ERR, err);
                    } else {
                        wrappedMessage = {
                            heartbeat: heartbeat.bind(null, this, record[0].hash),
                            message: record[0].messageBase64,
                            requeue: requeue.bind(null, this, record[0].hash),
                            remove: remove.bind(null, this, record[0].hash),
                            topics: record[0].topics
                        };

                        this.emit(EMIT_DATA, wrappedMessage);
                    }
                }
            );
        }


        /**
         * Opens a connection to a MySQL database.
         *
         * @param {Function} callback
         */
        connect(callback) {
            var connectionOptions, mysqlOptions;

            /*
            These are not all of the options that a mysql connection can
            take, only what is most relevant to this plugin.
            See the MySQL documentation for the rest.
            */
            mysqlOptions = [
                "database",
                "host",
                "password",
                "port",
                "table",
                "user"
            ];
            connectionOptions = {};

            mysqlOptions.forEach((key) => {
                if (this.config[key]) {
                    connectionOptions[key] = this.config[key];
                }
            });

            this.connection = mysql.createConnection(connectionOptions);
            this.connection.connect((err) => {
                if (err) {
                    throw new Error("There was an error while attempting to connect to the database.");
                }

                callback(false);
            });
        }


        /**
         * Severs the connection from the database.
         *
         * @param {Function} callback
         */
        disconnect(callback) {
            this.connection.end(callback);
        }


        /**
         * Starts polling.
         *
         * @param {Function} callback
         */
        listen(callback) {
            this.currentlyPolling = true;
            poll(this, callback);
            restore(this);
        }


        /**
         * Resets the relevant flags and clears the timers, which stops polling.
         */
        pausePolling() {
            timers.clearTimeout(this.poller);
            timers.clearTimeout(this.restorer);
            this.poller = null;
            this.restorer = null;
            this.currentlyPolling = false;
        }


        /**
         * Sets the currentlyPolling flag and starts polling.
         */
        resumePolling() {
            this.currentlyPolling = true;
            poll(this);
            restore(this);
        }


        /**
         * Inserts a record to the database. If it's unable to do so because the
         * record already exists, it will check directly that the entry exists
         * and if it does, attempt to update the record.
         *
         * Inserting a record will repeat as many times as are defined in the
         * config's createMessageCycleLimit.
         *
         * @param {Object} message
         * @param {string} topics
         * @param {Function} callback
         */
        sendMessage(message, topics, callback) {
            var cycleCounter, ddqBackendInstance, hash, writeRecord;

            cycleCounter = 0;
            // eslint-disable-next-line consistent-this
            ddqBackendInstance = this;
            hash = crypto.createHash("sha256").update(message).digest("hex");


            /**
             * Tries to create a record. If a record already exists with the
             * parameters, it will attempt to update that record. Otherwise, it
             * will call the callback that was provided to sendMessage.
             */
            function trySendMessage() {
                if (cycleCounter < ddqBackendInstance.config.createMessageCycleLimitMs) {
                    cycleCounter += 1;
                    ddqBackendInstance.connection.query(`INSERT INTO ?? (hash, messageBase64, topics)
                        VALUES (?, ?, ?);`,
                        [
                            ddqBackendInstance.config.table,
                            hash,
                            message,
                            topics
                        ],
                        (err) => {
                            if (err && err.code === "ER_DUP_ENTRY") {
                                console.error("Message already exists.");
                                console.error("Attempting to update existing record now.");
                                writeRecord();
                            } else if (err) {
                                ddqBackendInstance.emit(EMIT_ERR, err);
                            } else {
                                console.log("Message was sent successfully.");
                                callback();
                            }
                        }
                    );
                } else {
                    callback(new Error("Could not send message."));
                }
            }


            /**
             * Updates a record. If there isn't an error, but no records are
             * updated, it calls the trySendMessage method. Otherwise, it will
             * call the callback that was provided to sendMessage.
             */
            writeRecord = function () {
                ddqBackendInstance.connection.query(`UPDATE ??
                    SET requeued = true
                    WHERE hash = ?
                    AND isProcessing = true;`,
                    [
                        ddqBackendInstance.config.table,
                        hash
                    ],
                    (err, data) => {
                        if (err) {
                            ddqBackendInstance.emit(EMIT_ERR, err);
                        } else if (data.affectedRows) {
                            console.error("Could not update record because it does not exist.");
                            console.error("Attempting to create record now.");
                            trySendMessage();
                        } else {
                            console.log("Update Successful");
                            callback();
                        }
                    }
                );
            };

            trySendMessage();
        }
    }

    return DdqBackendMySql;
};