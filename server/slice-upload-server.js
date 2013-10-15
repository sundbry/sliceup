/* Node.js slice-upload protocol server
 * (c) 2013 by Ryan Sundberg
 */

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var WebSocketServer = require('ws').Server;

/** System-wide server environment */
function SliceUploadServerEnv() {

	this.dataDir = '.';
	this.port = 1337;

	this.init = function() {
		var self = this;
		this.liveHandles = {};
		this.wss = new WebSocketServer({ 'port': this.port });
		this.wss.on('connection', function(ws) {
			new SliceUploadServer(self, ws);			
		});
		this.log('WhatsUP Maria! 0.4');
	}

	/** Create and exclusively open a new handle (file) */
	this.newHandle = function(fileSize, callback, errorCallback) {
		var self = this;
		var onRandomName = function(name) {
			if(self.liveHandles[name] == undefined) {
				var path = self.makeHandlePath(name);
				// node.js will not switch context between these lines
				self.liveHandles[name] = {
					'name': name,
				       	'path': path,
				       	'isOpen': true,
				       	'size': fileSize,
				       	'bytesWritten': 0
				};
				self.liveHandles[name].writeStream = fs.createWriteStream(path, {
					flags: 'wx',
				    	encoding: null,
				    	mode: 0660
				});
				self.liveHandles[name].writeStream
					.on('open', function() {
						callback(self.liveHandles[name]);
					})
					.on('close', function() {
						self.liveHandles[name].writeStream = null;
					})
					.on('error', errorCallback);
			}
			else {
				self.createRandomName(onRandomName);
			}
		}
		this.createRandomName(onRandomName);
	}

	/** Exculsively open an existing handle */
	this.openHandle = function(name, callback, errorCallback) {
		var self = this;
		if(this.liveHandles[name] == undefined) {
			errorCallback({
				name: 'expired',
				message: 'File expired.'
			});
			return;
		}
		if(this.liveHandles[name].isOpen) {
			errorCallback({
				name: 'in-use',
				message: 'File is open in another session.'
			});
			return;
		}
		this.liveHandles[name].isOpen = true;
		fs.stat(this.liveHandles[name].path, function(err, stat) {
				if(err) {
					errorCallback(err);
					return;
				}
				self.liveHandles[name].bytesWritten = stat.size;
				self.liveHandles[name].writeStream = fs.createWriteStream(self.liveHandles[name].path, {
					flags: 'r+',
					encoding: null
				});
				self.liveHandles[name].writeStream
					.on('open', function() {
						callback(self.liveHandles[name]);
					})
					.on('close', function() {
						self.liveHandles[name].writeStream = null;
					})
					.on('error', errorCallback);
			}
		);
	}

	/** Close an open handle */
	this.closeHandle = function(name, callback, errorCallback) {
		var self = this;
		// unsubscribe all callbacks on fileStream
		if(this.liveHandles[name] == undefined) {
			errorCallback({
				name: 'expired',
				message: 'File expired.'
			});
			return;
		}
		// the following error should never happen if code is properly closing up
		if(!this.liveHandles[name].isOpen) {
			errorCallback({
				name: 'error',
				message: 'Upload handle is not open'
			});
			return;
		}
		if(this.liveHandles[name].writeStream == null) {
				this.liveHandles[name].isOpen = false;
				callback();
		}
		else {
			this.liveHandles[name].writeStream.on('close', function() {
				self.liveHandles[name].isOpen = false;
				self.liveHandles[name].writeStream = null;
				callback();
			});
			this.liveHandles[name].writeStream.end();
		}
	}

	/** Close and remove a handle no longer in use */
	this.removeHandle = function(name, callback, errorCallback) {
		var self = this;
		this.closeHandle(name, function() {
			fs.unlink(self.liveHandles[name].path, function(err) {
					self.liveHandles[name] = undefined;
					if(err) errorCallback(err);
					else callback();
				}, errorCallback);
		});
	}

	this.log = function(message) {
		//process.stdout.write("Info|" + message.toString() + "\n");
		//process.stdout.write(message);
		console.log(message);
	}

	this.errorLog = function(error) {
		console.log(error);
		//process.stderr.write("Error|" + error.toString() + "\n");
		if(error.stack) {
			//process.stderr.write(error.stack + "\n");
			console.log(error.stack);
		}
	}

	/* Private helpers */
	this.createRandomName = function(callback) {
		var nameHash = crypto.createHash('sha1');
		crypto.pseudoRandomBytes(32, function(ex, buf) {
			if(ex) throw ex;
			// hash buf so the server won't expose the raw RNG state 
			var name = nameHash.update(buf);
			callback(name.digest('hex'));
		});
	}

	this.makeHandlePath = function(name) {
		return path.join(this.dataDir, name + '.tmp');
	}

	this.init();

}

function SliceUploadServer(env, wsocket) {

	this.port = 1337;

	/** These exception names are allowed through. Others get sanitized to a generic error */
	this.errorFilterNames = [
		'illegal-operation',
		'invalid-command',
		//'io-error',
		'upload-failure',
		'expired',
		'in-use'
	]

	this.init = function() {
		var self = this;
		this.env = env;
		this.ws = wsocket;
		this.ws.on('close', function(){self.onExit()});
		this.handle = null;
		this.enterCommandMode();
		this.initCommandSet();
		this.env.log('Socket opened');
	}

	this.initCommandSet = function() {
		var self = this;
		this.command = {
			'new': function(params) {
				if(params.size == undefined) {
					self.throwInvalidCommand();
				}
				self.openNew(parseInt(params.size), function() {
					console.log('size,bytesWritten:');
					console.log(self.handle.size);
					console.log(self.handle.bytesWritten);
					if(self.handle.bytesWritten < self.handle.size) {
						self.enterDataMode();
					}
					self.sendResponse('new', { 'handle': self.handle.name }, function(){});
				});
			},
			'resume': function(params) {
				if(params.handle == undefined) {
					self.throwInvalidCommand();
				}
				self.openResume(params.handle, function() { 
					if(self.handle.bytesWritten < self.handle.size) {
						self.enterDataMode();
					}
					self.sendResponse('resumed', { 'position': self.handle.bytesWritten });
				});
			},
			'ack-complete': function(params) {
				if(params.handle == undefined || params.pad == undefined) {
					self.throwInvalidCommand();
				}
				self.verifyComplete(params.handle, parseInt(params.pad), function(verified) {
					if(verified) {
						self.sendResponse('complete', {}, function() {
							self.onComplete();
						});
					}
					else {
						self.abortAndFail(params.handle, {
							name: 'upload-failure',
							message: 'Upload verification failed.'
						});
					}
				});
			},
			'abort': function(params) {
				if(params.handle == undefined) {
					this.throwInvalidCommand();
				}
				self.abort(params.handle, function() {
					self.sendResponse('aborted', {});
				});
			}
		};
	}

	this.enterCommandMode = function() {
		var self = this;
		this.env.log('[COMMAND mode]');
		this.ws.removeAllListeners('message');
		this.ws.on('message', function(e){self.commandReceived(e)});
	}

	this.enterDataMode = function() {
		var self = this;
		this.env.log('[DATA mode]');
		this.ws.removeAllListeners('message');
		this.ws.on('message', function(e){self.dataReceived(e)});
	}

	this.commandReceived = function(data) {
		try {
			var buf = new ArrayBuffer(data.length);
			var buf8 = new Uint8Array(buf);
			buf8.set(data);
			var strBuf = new Uint16Array(buf);
			var cmdStr = String.fromCharCode.apply(null, strBuf);
			try {
				var cmd = JSON.parse(cmdStr);
			}
			catch(e) {
				// possibly data being sent while we re-entered command mode on io error
				this.env.log('Junk command recieved (' + data.length + ' bytes)');
				return;
			}
			this.env.log(cmd);
			var doCmd = this.command[cmd['command']];
			if(doCmd == undefined) {
				this.throwInvalidCommand();
			}
			doCmd(cmd);
		}
		catch(err) {
			this.sendError(err);
		}
	}

	this.dataReceived = function(data) {
		var self = this;
		try {
			if(this.handle == null) {
				throwIllegalError(1);
			}
			if(!this.handle.isOpen) {
				throwIllegalError(2);
			}
			if(this.handle.writeStream == null) {
				throwIllegalError(3);
			}
			// todo: rate limit in the protocol. What happens when net io faster than file io? Bad things probably.
			this.handle.writeStream.write(data);
			this.handle.bytesWritten += data.length;
			if(this.handle.bytesWritten >= this.handle.size) {
				this.handle.writeStream.end();
				this.enterCommandMode();
			}
		}
		catch(err) {
			this.sendError(err);
		}
	}

	/** Throw error due to illegal state, evidence of bug in code */
	this.throwIllegalError = function(errorCode) {
		throw {
			name: 'illegal-operation',
			message: 'Upload server error (' + errorCode + ')'
		};
	}

	this.throwInvalidCommand = function() {
		throw {
			name: 'invalid-command',
			message: 'Invalid slice upload command.'
		};
	}

	this.throwIfHandleOpen = function() {
		if(this.handle != null) {
			throw {
				name: 'in-use',
				message: 'File is currently open in another connection.'
			};
		}
	}

	this.sendResponse = function(result, params, callback) {
		var self = this;
		var obj = { 'result': result };
		Object.keys(params).forEach(function(param) {
			obj[param] = params[param];
		});
		this.env.log(obj);
		var json = JSON.stringify(obj);
		this.ws.send(json, function(err) {
			if(err == null) {
				if(callback) {
					callback();
				}
			}
			else {
				self.disconnect();
			}
		});
	}

	this.sendError = function(ex) {
		var self = this;
		this.env.errorLog(ex);
		var json = JSON.stringify(this.sanitizeError(ex));
		this.ws.send(json, function(err) {
			if(err != null)
				self.disconnect();
		});
		this.enterCommandMode();
	}

	this.sanitizeError = function(ex) {
		var name = ex.name;
		var message = ex.message;

		if(this.errorFilterNames.indexOf(name) == -1) {
			var errorLookupCode = 10 + (name.length % 10);
			name = 'server-error';
			message = 'An error occurred on the server (' + errorLookupCode + ')';
		}
		return {'result': 'error', 'error': name, 'message': message }
	}

	this.disconnect = function() {
		this.close();
	}

	this.openNew = function(size, callback) {
		var self = this;
		this.throwIfHandleOpen();
		this.handle = this.env.newHandle(size, function(newHandle) {
				self.handle = newHandle;
				callback()
			},
		       	function(e){self.sendError(e)});
	}

	this.openResume = function(resumeHandleName, callback) {
		var self = this;
		this.throwIfHandleOpen();
		this.env.openHandle(resumeHandleName, function(resumedHandle) {
				self.handle = resumedHandle;
				callback();
			},
			function(e){self.sendError(e)}
		);
	}

	this.verifyComplete = function(completeHandleName, padSize, callback) {
		var self = this;
		this.requireOpenHandle(completeHandleName, function() {
				var doStatCallback = function() {
					if(self.handle != null) {
						fs.stat(self.handle.path, function(err, res) {
							if(err) callback(false);
							callback(self.handle.size == res.size);
						});
					}
					// else, client timed out and closed connection before verification complete
					// omit callback execution
				};

				// if file already closed, stat size of file
				if(self.handle.writeStream == null) {
					doStatCallback();
				}
				// else wait for file closure (upon data completion)
				else {
					self.handle.writeStream.on('close', doStatCallback);
				}
			},
			function(err) {
				self.sendError(err);
			}
		);
	}

	this.abort = function(abortHandleName, callback) {
		var self = this;
		this.requireOpenHandle(abortHandleName, function() {
				self.env.removeHandle(abortHandleName, callback, function(e){self.sendError(e)});
				self.handle = null;
			},
		       	function(err) {
				// return OK if handle is expired
				if(err.name == 'expired') {
					self.handle = null;
					callback();
				}
				else {
					self.sendError(err);
				}
			}
		);
	}

	this.abortAndFail = function(abortHandleName, error) {
		var self = this;
		this.abort(abortHandleName, function() {
			self.sendError(error);
		});
	}

	this.requireOpenHandle = function(handleName, callback, errorCallback) {
		if(this.handle == null) {
			this.handle = this.env.openHandle(handleName, callback, errorCallback);
		}
		else {
			if(this.handle.name != handleName) {
				try {
					this.throwIfHandleOpen();
				}
				catch(err) {
					errorCallback(err);
					return;
				}
			}
			callback();
		}
	}

	this.onComplete = function() {
		var self = this;
		this.env.log('File complete (' + this.handle.size + ' bytes)');
		this.env.removeHandle(this.handle.name, function(){}, function(e){self.sendError(e)});
		this.handle = null;
	}

	this.onExit = function() {
		var self = this;
		if(this.handle != null) {
			this.env.closeHandle(this.handle.name, function(){}, function(e){self.sendError(e)});
			this.handle = null;
		}
		this.env.log('Socket closed');
	}

	this.init();

}

var serverEnv = new SliceUploadServerEnv();
