/**
 * This class uses HTML5 file slicing and WebSockets to control upload streams.
 * Includes hooks for adding socket layer protocols.
 * (c) 2013 Ryan R Sundberg <ryan.sundberg@gmail.com>
*/

/** Construct a SliceUploadFileStream with a DOM file and options dict.
 * @param file: DOM file
 * @param opts: {
 * 	url: string, // web socket url
 * 	createProtocolHandler: (SliceUploadFileStream) -> AbstractUserProtocolHander, // transfer protocol policy layer
 * }
 * 
 * This is an event emitter, use on(name, func) to register event callbacks.
 * Events are: 
 * 	resumable-error: (Error)	// resumable error
 * 	fatal-error: (Error)		// restartable error
 * 	start: () 					// successful start of a new file
 * 	stop: ()  					// stop due to error or completion
 * 	resume: () 					// successful resume of a file
 *	progress: (float)  			// upload progress
 *	complete: ()  				// successful upload
 */
function SliceUploadFileStream(file_param, opts_param) {

	this.init = function() {
		var self = this;
		this.sendBufWaitMs = 1;
		this.file = file_param;
		this.opts = opts_param;
		this.fileSliceSize = 64000; //32768; // 32k
		this.fileReader = new FileReader();
		this.numSlices = Math.floor(this.file.size / this.fileSliceSize) + (this.file.size % this.fileSliceSize == 0 ? 0 : 1);
		this.nextFileSlice = 0;
		this.nextSocketSlice = 0;
		this.initialSliceOffset = 0;
		this.sendBufHasPrevious = false;
		this.socket = null;
		this.knownError = null;
		this.progressModulation = 8; // 8x slice size, about 512k
		this.progressCount = 0;
		this.protocolHandler = opts_param.createProtocolHandler(this);
		this.initFileEvents();
	}

	/* Public methods */
	this.start = function() {
		var self = this;
		this.protocolHandler.invokeNewUpload(function() {
			self.emit('start', 0);
			self.startAtByte(0);
		});
	}
	/** Resume the upload */
	this.resume = function() {
		var self = this;
		this.protocolHandler.invokeResume(function(pos) {
			self.emit('resume', pos);
			self.startAtByte(pos);
		});
	}

	/** Restart the upload. */
	this.restart = function() {
		var self = this;
		var startFun = function(){self.start()};
		this.protocolHandler.invokeSafeAbort(startFun, startFun);
	}
	
	/* Getters */
	
	this.fileSize = function() {
		return this.file.size;
	}
	
	/* Protocol controls */

	/** Start sending from a byte index.
	 * @pre bytePos < size
	 */
	this.startAtByte = function(bytePos) {
		var sliceNum = Math.floor(bytePos / this.fileSliceSize);
		if(sliceNum >= this.numSlices) {
			throw "at end of file"
		}
		this.progressCount = 0;
		this.initialSliceOffset = bytePos % this.fileSliceSize;
		this.nextFileSlice = sliceNum;
		this.nextSocketSlice = sliceNum;
		this.sendBufHasPrevious = false;
		this.onProgress(1.0 * bytePos / this.fileSize());
		this.beginNextSlice();
	}

	this.beginNextSlice = function() {
		if(this.nextSocketSlice > this.nextFileSlice) {
			throw "File already queued"
		}
		if(this.nextFileSlice < this.numSlices) {
			var self = this;
			this.requireSocket(function(){self.readFileBuf()});
		}
		else {

		}
	}

	/** Close (disconnect) the socket, allowing retry to resume */
	this.disconnectDirty = function() {
		if(this.socket != null) {
			this.socket.close(4000, "Socket reset");
			return true;
		}
		return false;
	}
	
	this.sendProtocolCommand = function(cmdStr) {
		var self = this;
		var cmdBuf = SliceUploadFileStream.strtoab(cmdStr);
		this.requireSocket(function() {
			self.socket.send(cmdBuf);
		});
	}

	this.triggerResumableError = function(name, msg) {
		this.triggerError(this.makeError(name, msg, true));
	}

	this.triggerFatalError = function(name, msg) {
		this.triggerError(this.makeError(name, msg, false));
	}
	
	this.triggerError = function(err) {
		this.knownError = err;
		if(!this.disconnectDirty()) {
			this.raiseError(err);
		}
	}

	/** Raise Resumable/Fatal error upon socket disconnection */
	this.raiseSocketError = function() {
		var err = this.knownError;
		if(err == null) {
			// resumable socket disconnect
			err = this.makeError('socket', "Connection reset.", true);
		}
		this.knownError = null;
		this.raiseError(err);
	}
	
	this.raiseError = function(err) {
		console.log(err);
		if(err.resumable) {
			this.emit('resumable-error', err);
		}
		else {
			this.emit('fatal-error', err);
		}
	};

	/* Internal event handlers */

	/** Binary transmission complete */
	this.onDataComplete = function() {
		var self = this;
		// perform upload complete handshakes etc
		this.protocolHandler.invokeUploadComplete(function() {
			self.socket.close();
			self.emit('complete', null);
		});
	};

	/** Upload progress update */
	this.onProgress = function(ratio) {
		if(this.progressCount++ % this.progressModulation == 0 || ratio == 1.0) {
			this.emit('progress', ratio);
		}
	};

	/** Data read from file buffer */
	this.onFileRead = function() {
		var self = this;
		this.nextFileSlice++;
		this.sendBufWhenReady(this.fileReader.result, function() {
			if(self.numSlices == self.nextFileSlice) {
				self.waitLastSlice();
			}
			else {
				self.beginNextSlice();
			}
		});
	};

	/* Private parts (. )( .) */

	this.initFileEvents = function() {
		var self = this;
		EventHelper.bindEventMap(this.fileReader, {
			'load': function() {
				self.onFileRead();
			},
			'error': function() {
				self.triggerFatalError('io-error', "File read error");
			}
		});
	};

	this.makeSocketEvents = function(onOpen) {
		var self = this;
		return {
			'open': function(evt) {
				self.socket = evt.target;
				self.protocolHandler.socket = self.socket;
				self.sendBufHasPrevious = false;
				onOpen();
			},
			// evt.code, evt.reason, evt.wasClean
			'close': function(evt) {
				SliceUploadFileStream.releaseTransferSocket(evt.target);
				self.socket = null;
				self.protocolHandler.socket = null;
				if(evt.code != 1000) { // CLOSE_NORMAL

					if(window.closed) {
						// browser closed, quit.
					}
					else {
						self.raiseSocketError();
					}
				}
				self.emit('stop', null);
			},
			'error': function(evt) {
				// defer recovery to close handler
				if(self.socket != null) {
					self.socket.close();
				}
			},
			'message': function(evt) {
				self.protocolHandler.invokeMessageReceived(evt.data);
			}
		};
	}

	this.requireSocket = function(whenOpen) {
		if(this.socket == null) {
			SliceUploadFileStream.openTransferSocket(this.opts.url, this.makeSocketEvents(whenOpen));
		}
		else {
			whenOpen();
		}
	}

	this.readFileBuf = function() {
		var blob = this.openSlice(this.nextFileSlice);
		this.fileReader.readAsArrayBuffer(blob); // async
	}

	this.openSlice = function(n) {
		if(n >= this.numSlices)
			throw "File slice out of range";
		var blob = this.browserOpenFileSlice(this.file, n * this.fileSliceSize + this.initialSliceOffset, (this.numSlices == n ? this.file.size : (n + 1) * this.fileSliceSize));
		this.initialSliceOffset = 0;
		return blob;
	}

	this.browserOpenFileSlice = function(file, startPos, endPos) {
		if(file.webkitSlice)
			return file.webkitSlice(startPos, endPos);
		if(file.mozSlice)
			return file.mozSlice(startPos, endPos);
		if(file.slice) {
			var res = file.slice(startPos, endPos);
			if(res)
				return res;
		}		
		throw "Your browser does not support the File API";
	}

	/** When the send buffer becomes ready, fill it and execute a continuation when the buffer is flushed. */
	this.sendBufWhenReady = function(arrayBuf, continueToSend) {
		if(this.socket != null && this.socket.readyState == this.socket.OPEN) {
			if(this.socket.bufferedAmount == 0) {
				var previousComplete = this.sendBufHasPrevious;
				this.socket.send(arrayBuf);
				this.sendBufHasPrevious = true;
				continueToSend();
				if(previousComplete) {
					this.sendBufComplete();
				}
			}
			else {
				var self = this;
				if(this.socket.bufferedAmount == undefined) return;
				window.setTimeout(function () {
					self.sendBufWhenReady(arrayBuf, continueToSend);
				}, this.sendBufWaitMs);
			}
		}
	}

	this.sendBufComplete = function() {
		this.nextSocketSlice++;
		this.onProgress(1.0 * this.nextSocketSlice / this.numSlices);
		if(this.nextSocketSlice == this.numSlices) {
			this.onDataComplete();
		}
	}

	this.waitLastSlice = function() {
		if(this.socket.readyState == this.socket.OPEN) {
			if(this.socket.bufferedAmount == 0) {
				if(this.sendBufHasPrevious) {
					this.sendBufComplete();
				}
				this.sendBufHasPrevious = false;
			}
			else {
				var self = this;
				window.setTimeout(function () {
					self.waitLastSlice();
				}, this.sendBufWaitMs);
			}
		}
	}

	/** Make an error object with a name and a message */
	this.makeError = function(name, msg, resumable) {
		var err = new Error(msg);
		err.name = name;
		err.resumable = resumable;
		return err;
	}

	this.init();
}

SliceUploadFileStream.prototype = Object.create(Emitter.prototype);

/* Static members */
SliceUploadFileStream.sockets = {};
SliceUploadFileStream.nextId = 1;

/* Public */

SliceUploadFileStream.strtoab = function(str) {
	var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
	var bufView = new Uint16Array(buf);
	for (var i=0, strLen=str.length; i<strLen; i++) {
		bufView[i] = str.charCodeAt(i);
	}
	return buf;
}

/** Request a socket, and bind the events in the map to it */
SliceUploadFileStream.openTransferSocket = function(url, userEventMap) {
	var sockInfo = {
		'socket': this.openSocket(url),
		'eventMap': userEventMap,
	};
	var id = this.makeSocketId();
	sockInfo.socket.myId = id;
	this.sockets[id] = sockInfo;
	EventHelper.bindEventMap(sockInfo.socket, sockInfo.eventMap);
}

/** Release a closed socket */
SliceUploadFileStream.releaseTransferSocket = function(sock) {
	var id = sock.myId;
	var sockInfo = this.sockets[id];
	this.sockets[id] = undefined;
	EventHelper.unbindEventMap(sockInfo.socket, sockInfo.eventMap);
}

/* Private helpers */

SliceUploadFileStream.openSocket = function(url) {
	var sock = new WebSocket(url);
	sock.binaryType = "arraybuffer";
	return sock;
}

SliceUploadFileStream.makeSocketId = function() {
	return (this.nextId++).toString();
}

function AbstractTransferProtocolHandler() {

	/** This method is called when a complete slice has been sent */
	/* use for rate limiting support
	this.sliceComplete = function() {

	};
	*/

	this.invokeNewUpload = function(continueWithUpload) {
		continueWithUpload();
	},

	/** This method is called when all total bytes have been sent. Give the protocol
	 * a chance to transmit before terminating the socket. */
	this.invokeUploadComplete = function(terminateUpload) {
		terminateUpload();
	},

	this.invokeResume = function(resumeUpload) {
		throw "Resume requires server protocol support"
	}

	this.invokeSafeAbort = function(onAbort, onAbortFailure) {
		onAbort();
	}

	this.invokeMessageReceived = function(message) {

	}
}