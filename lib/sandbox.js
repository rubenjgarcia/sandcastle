var _ = require('lodash')
var net = require('net')
var vm = require('vm')
var BufferStream = require('bufferstream')
var clone = require('clone')

function Sandbox (opts) {
  _.extend(this, {
    socket: '/tmp/sandcastle.sock'
  }, opts)
}

Sandbox.prototype.start = function () {
  var _this = this

  this.server = net.createServer(function (c) {
    var stream = new BufferStream({ size: 'flexible' })

    // script begin
    stream.split('\u0000\u0000', function (chunk) {
      _this.executeScript(c, chunk)
    })

    // recieved answer
    stream.split('\u0000', function (chunk) {
      _this.answerTask(c, chunk)
    })

    c.on('data', stream.write)
  })

  this.server.listen(this.socket, function () {
    console.log('sandbox server created') // emit data so that sandcastle knows sandbox is created
  })

  this.server.on('error', function () {
    setTimeout(function () {
      _this.start()
    }, 500)
  })
}

Sandbox.prototype._sendError = function (connection, e, replaceStack) {
  connection.write(
    JSON.stringify({
      error: {
        message: e.message,
        stack: !replaceStack ? e.stack : e.stack.replace()
      }
    }) + '\u0000\u0000') // exit/start separator
}

Sandbox.prototype.answerTask = function (connection, data) {
  var _this = this

  try {
    var taskData = JSON.parse(data.toString())
    var taskName = taskData.task
    var onAnswerName = 'on' + taskName.charAt(0).toUpperCase() + taskName.slice(1) + 'Task'

    if (this._ctx.exports[ onAnswerName ]) {
      this._ctx.exports[ onAnswerName ](taskData.data)
    } else if (this._ctx.exports.onTask) {
      this._ctx.exports.onTask(taskName, taskData.data)
    }
  } catch (e) {
    _this._sendError(connection, e)
  }
}

Sandbox.prototype.executeScript = function (connection, data) {
  var _this = this

  var contextObject = {
    runTask: function (taskName, options) {
      options = options || {}

      try {
        connection.write(
          JSON.stringify({
            task: taskName,
            options: options
          }) + '\u0000') // task seperator
      } catch (e) {
        _this._sendError(connection, e, false)
      }
    },
    exit: function (output) {
      try {
        connection.write(JSON.stringify(output) + '\u0000\u0000') // exit/start separator
      } catch (e) {
        _this._sendError(connection, e, true)
      }
    }
  }

  try {
    var script = JSON.parse(data)

    // The trusted global variables.
    if (script.globals) {
      var globals = JSON.parse(script.globals)

      Object.keys(globals).forEach(function (key) {
        contextObject[ key ] = globals[ key ]
      })
    }

    // The trusted API.
    if (script.sourceAPI) {
      var api = eval(script.sourceAPI) // eslint-disable-line

      Object.keys(api).forEach(function (key) {
        contextObject[ key ] = api[ key ]
      })
    }

    // recursively clone contextObject without prototype,
    // to prevent exploits using __defineGetter__, __defineSetter__.
    // https://github.com/bcoe/sandcastle/pull/21
    contextObject = clone(contextObject, true, Infinity, null)

    this._ctx = vm.createContext(contextObject)
    var vmScript = new vm.Script(this.wrapForExecution(script.source, script.methodName), {filename: script.filename || 'sandbox.js', lineOffset: -2})
    vmScript.runInNewContext(this._ctx, {timeout: script.timeout || 5000})
  } catch (e) {
    this._sendError(connection, e, false)
  }
}

Sandbox.prototype.wrapForExecution = function (source, methodName) {
  return '"use strict";\nvar exports = Object.create(null);\n' + source + '\nexports.' + methodName + '();'
}

exports.Sandbox = Sandbox
