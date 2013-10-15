/** WebSocket Slice-Upload Protcol Client
 * (c) 2013 Ryan Sundberg <ryan.sundberg@gmail.com>	
 */
function WSSliceProtocolHandler(fileStreamInstance) {

	this.responseTimeoutMs = 10000;

	this.init = function() {
		var self = this;
		this.fileStream = fileStreamInstance;
		this.serverHandle = null;
		this.handleNextResponse = null;
		this.responseTimeout = null;

		this.protocolCommand = {
			'new': function(continueWithUpload) {
				self.sendCommand('new', {
						'size': self.fileStream.fileSize(), // double can hold accurate int up to 2^53
					},
					function(responseObj) {
						if(responseObj.result == "new") {
							self.serverHandle = responseObj.handle;
							continueWithUpload();
						}
						else {
							self.protoError();
						}
					}
				);
			},
			'ack-complete': function(terminateUpload) {
				self.sendCommand('ack-complete', {
						'handle': self.serverHandle,
						'pad': 0,
					},
					function(responseObj) {
						if(responseObj.result == "complete") {
							terminateUpload();
						}
						else {
							self.protoError();
						}
					}
				);
			},
			'resume': function(resumeUploadAt, completeUpload) {
				self.sendCommand('resume', {
						'handle': self.serverHandle
					},
					function(responseObj) {
						if(responseObj.result == "resumed") {
							if(responseObj.position < self.fileStream.fileSize()) {
								resumeUploadAt(responseObj.position);
							}
							else if(responseObj.position == self.fileStream.fileSize()) {
								completeUpload();
							}
							else {
								self.protoError();
							}
						}
						else {
							self.protoError();
						}
					} 
				);
			},
			'abort': function(onAbort) {
				self.sendCommand('abort', {
						'handle': self.serverHandle
					},
					function(responseObj) {
						if(responseObj.result == "aborted") {
							onAbort();
						}
						else {
							self.protoError();
						}
					}
				);
			}
		};
	}

	this.sendCommand = function(name, params, handleResponse) {
		this.handleNextResponse = handleResponse;
		var obj = { 'command': name };
		Object.keys(params).forEach(function(param) {
			obj[param] = params[param];
		});

		var json = JSON.stringify(obj);
		this.beginResponseTimeout();
		this.fileStream.sendProtocolCommand(json);
	}

	this.invokeNewUpload = function(continueWithUpload) {
		this.protocolCommand['new'](continueWithUpload);
	}

	this.invokeUploadComplete = function(terminateUpload) {
		this.protocolCommand['ack-complete'](terminateUpload);
	}

	this.invokeResume = function(resumeUpload) {
		if(this.serverHandle == null) {
			this.invokeNewUpload(resumeUpload);
		}
		else {
			this.protocolCommand['resume'](resumeUpload);
		}
	}

	/* Graciously abort server-side if socket is OK, else do nothing */
	this.invokeSafeAbort = function(onAbort, onAbortFailure) {
		try {
			this.protocolCommand['abort'](onAbort);
		}
		catch(err) {
			onAbortFailure();
		}
	}

	this.invokeMessageReceived = function(message) {
		this.clearResponseTimeout();
		var responseObj = JSON.parse(message); // throws
		if(responseObj.result == "error") {
			this.handleServerError(responseObj);
		}
		else {
			this.handleNextResponse(responseObj);
		}
	}

	this.handleServerError = function(error) {
		if(error.name == 'in-use') {
			this.fileStream.triggerResumableError(error.name, error.message);	
		}
		else {
			this.fileStream.triggerFatalError(error.name, error.message);	
		}
	}

	/** Raise a protocol error due to invalid state changes */
	this.protoError = function() {
		this.fileStream.triggerFatalError('protocol-error', 'Slice-upload server protocol error');
	}

	this.beginResponseTimeout = function() {
		var self = this;
		this.responseTimeout = window.setTimeout(function(){self.timeoutError()}, this.responseTimeoutMs);
	}

	this.clearResponseTimeout = function() {
		if(this.responseTimeout != null) {
			window.clearTimeout(this.responseTimeout);
			this.responseTimeout = null;
		}
	}

	/** Raised on response timeout. Error clears the pending timeout. */
	this.timeoutError = function() {
		this.responseTimeout = null;
		this.fileStream.triggerResumableError('timeout', 'Upload server timeout.');
	}

	this.init();

}

WSSliceProtocolHandler.prototype = new AbstractTransferProtocolHandler();
