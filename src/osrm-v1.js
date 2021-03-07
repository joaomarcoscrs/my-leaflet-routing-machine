/* eslint-disable eqeqeq */
/* eslint-disable prefer-const */
/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable no-return-assign */
/* eslint-disable no-tabs */
(function () {
  'use strict'

  const L = require('leaflet')
  const corslite = require('@mapbox/corslite')
  const polyline = require('@mapbox/polyline')
  const osrmTextInstructions = require('osrm-text-instructions')('v5')

  // Ignore camelcase naming for this file, since OSRM's API uses
  // underscores.
  /* jshint camelcase: false */

  const Waypoint = require('./waypoint')

  /**
	 * Works against OSRM's new API in version 5.0; this has
	 * the API version v1.
	 */
  module.exports = L.Class.extend({
    options: {
      serviceUrl: 'https://routing.openstreetmap.de/routed-car/route/v1',
      profile: 'driving',
      timeout: 30 * 1000,
      routingOptions: {
        alternatives: true,
        steps: true
      },
      polylinePrecision: 5,
      useHints: true,
      suppressDemoServerWarning: false,
      language: 'en'
    },

    initialize (options) {
      L.Util.setOptions(this, options)
      this._hints = {
        locations: {}
      }

      if (!this.options.suppressDemoServerWarning &&
				this.options.serviceUrl.includes('//router.project-osrm.org')) {
        console.warn('You are using OSRM\'s demo server. ' +
					'Please note that it is **NOT SUITABLE FOR PRODUCTION USE**.\n' +
					'Refer to the demo server\'s usage policy: ' +
					'https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy\n\n' +
					'To change, set the serviceUrl option.\n\n' +
					'Please do not report issues with this server to neither ' +
					'Leaflet Routing Machine or OSRM - it\'s for\n' +
					'demo only, and will sometimes not be available, or work in ' +
					'unexpected ways.\n\n' +
					'Please set up your own OSRM server, or use a paid service ' +
					'provider for production.')
      }
    },

    route (waypoints, callback, context, options) {
      let timedOut = false
      const wps = []
      let url
      let timer
      let wp
      let i
      let xhr

      options = L.extend({}, this.options.routingOptions, options)
      url = this.buildRouteUrl(waypoints, options)
      if (this.options.requestParameters) {
        url += L.Util.getParamString(this.options.requestParameters, url)
      }

      timer = setTimeout(function () {
        timedOut = true
        callback.call(context || callback, {
          status: -1,
          message: 'OSRM request timed out.'
        })
      }, this.options.timeout)

      // Create a copy of the waypoints, since they
      // might otherwise be asynchronously modified while
      // the request is being processed.
      for (i = 0; i < waypoints.length; i++) {
        wp = waypoints[i]
        wps.push(new Waypoint(wp.latLng, wp.name, wp.options))
      }

      return xhr = corslite(url, L.bind(function (err, resp) {
        let data
        const error = {}

        clearTimeout(timer)
        if (!timedOut) {
          if (!err) {
            try {
              data = JSON.parse(resp.responseText)
              try {
                return this._routeDone(data, wps, options, callback, context)
              } catch (ex) {
                error.status = -3
                error.message = ex.toString()
              }
            } catch (ex) {
              error.status = -2
              error.message = 'Error parsing OSRM response: ' + ex.toString()
            }
          } else {
            error.message = 'HTTP request failed: ' + err.type +
							(err.target && err.target.status ? ' HTTP ' + err.target.status + ': ' + err.target.statusText : '')
            error.url = url
            error.status = -1
            error.target = err
          }

          callback.call(context || callback, error)
        } else {
          xhr.abort()
        }
      }, this))
    },

    requiresMoreDetail (route, zoom, bounds) {
      if (!route.properties.isSimplified) {
        return false
      }

      const waypoints = route.inputWaypoints
      let i
      for (i = 0; i < waypoints.length; ++i) {
        if (!bounds.contains(waypoints[i].latLng)) {
          return true
        }
      }

      return false
    },

    _routeDone (response, inputWaypoints, options, callback, context) {
      const alts = []
			    let actualWaypoints
			    let i
			    let route

      context = context || callback
      if (response.code !== 'Ok') {
        callback.call(context, {
          status: response.code
        })
        return
      }

      actualWaypoints = this._toWaypoints(inputWaypoints, response.waypoints)

      for (i = 0; i < response.routes.length; i++) {
        route = this._convertRoute(response.routes[i])
        route.inputWaypoints = inputWaypoints
        route.waypoints = actualWaypoints
        route.properties = {isSimplified: !options || !options.geometryOnly || options.simplifyGeometry}
        alts.push(route)
      }

      this._saveHintData(response.waypoints, inputWaypoints)

      callback.call(context, null, alts)
    },

    _convertRoute (responseRoute) {
      const result = {
        name: '',
        coordinates: [],
        instructions: [],
        summary: {
          totalDistance: responseRoute.distance,
          totalTime: responseRoute.duration
        }
      }
      const legNames = []
      const waypointIndices = []
      let index = 0
      const legCount = responseRoute.legs.length
      const hasSteps = responseRoute.legs[0].steps.length > 0
      let i
      let j
      let leg
      let step
      let geometry
      let type
      let modifier
      let text
      let stepToText

      if (this.options.stepToText) {
        stepToText = this.options.stepToText
      } else {
        stepToText = L.bind(osrmTextInstructions.compile, osrmTextInstructions, this.options.language)
      }

      for (i = 0; i < legCount; i++) {
        leg = responseRoute.legs[i]
        legNames.push(leg.summary && leg.summary.charAt(0).toUpperCase() + leg.summary.substring(1))
        for (j = 0; j < leg.steps.length; j++) {
          step = leg.steps[j]
          geometry = this._decodePolyline(step.geometry)
          result.coordinates.push.apply(result.coordinates, geometry)
          type = this._maneuverToInstructionType(step.maneuver, i === legCount - 1)
          modifier = this._maneuverToModifier(step.maneuver)
          text = stepToText(step, {legCount, legIndex: i})

          if (type) {
            if ((i == 0 && step.maneuver.type == 'depart') || step.maneuver.type == 'arrive') {
              waypointIndices.push(index)
            }

            result.instructions.push({
              type,
              distance: step.distance,
              time: step.duration,
              road: step.name,
              direction: this._bearingToDirection(step.maneuver.bearing_after),
              exit: step.maneuver.exit,
              index,
              mode: step.mode,
              modifier,
              text
            })
          }

          index += geometry.length
        }
      }

      result.name = legNames.join(', ')
      if (!hasSteps) {
        result.coordinates = this._decodePolyline(responseRoute.geometry)
      } else {
        result.waypointIndices = waypointIndices
      }

      return result
    },

    _bearingToDirection (bearing) {
      const oct = Math.round(bearing / 45) % 8
      return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][oct]
    },

    _maneuverToInstructionType (maneuver, lastLeg) {
      switch (maneuver.type) {
        case 'new name':
          return 'Continue'
        case 'depart':
          return 'Head'
        case 'arrive':
          return lastLeg ? 'DestinationReached' : 'WaypointReached'
        case 'roundabout':
        case 'rotary':
          return 'Roundabout'
        case 'merge':
        case 'fork':
        case 'on ramp':
        case 'off ramp':
        case 'end of road':
          return this._camelCase(maneuver.type)
          // These are all reduced to the same instruction in the current model
          // case 'turn':
          // case 'ramp': // deprecated in v5.1
        default:
          return this._camelCase(maneuver.modifier)
      }
    },

    _maneuverToModifier (maneuver) {
      let modifier = maneuver.modifier

      switch (maneuver.type) {
        case 'merge':
        case 'fork':
        case 'on ramp':
        case 'off ramp':
        case 'end of road':
          modifier = this._leftOrRight(modifier)
      }

      return modifier && this._camelCase(modifier)
    },

    _camelCase (s) {
      const words = s.split(' ')
      let result = ''
      for (let i = 0, l = words.length; i < l; i++) {
        result += words[i].charAt(0).toUpperCase() + words[i].substring(1)
      }

      return result
    },

    _leftOrRight (d) {
      return d.includes('left') ? 'Left' : 'Right'
    },

    _decodePolyline (routeGeometry) {
      const cs = polyline.decode(routeGeometry, this.options.polylinePrecision)
      const result = new Array(cs.length)
      let i
      for (i = cs.length - 1; i >= 0; i--) {
        result[i] = L.latLng(cs[i])
      }

      return result
    },

    _toWaypoints (inputWaypoints, vias) {
      const wps = []
			    let i
			    let viaLoc
      for (i = 0; i < vias.length; i++) {
        viaLoc = vias[i].location
        wps.push(new Waypoint(L.latLng(viaLoc[1], viaLoc[0]),
				                            inputWaypoints[i].name,
          inputWaypoints[i].options))
      }

      return wps
    },

    buildRouteUrl (waypoints, options) {
      const locs = []
      const hints = []
      let wp
      let latLng
			    let computeInstructions
			    const computeAlternative = true

      for (let i = 0; i < waypoints.length; i++) {
        wp = waypoints[i]
        latLng = wp.latLng
        locs.push(latLng.lng + ',' + latLng.lat)
        hints.push(this._hints.locations[this._locationKey(latLng)] || '')
      }

      computeInstructions =
				true

      return this.serviceUrl + '/' + this.options.profile + '/' +
				locs.join(';') + '?' +
				(options.geometryOnly ? (options.simplifyGeometry ? '' : 'overview=full') : 'overview=false') +
				'&alternatives=' + computeAlternative.toString() +
				'&steps=' + computeInstructions.toString() +
				(this.options.useHints ? '&hints=' + hints.join(';') : '') +
				(options.allowUTurns ? '&continue_straight=' + !options.allowUTurns : '')
    },

    _locationKey (location) {
      return location.lat + ',' + location.lng
    },

    _saveHintData (actualWaypoints, waypoints) {
      let loc
      this._hints = {
        locations: {}
      }
      for (let i = actualWaypoints.length - 1; i >= 0; i--) {
        loc = waypoints[i].latLng
        this._hints.locations[this._locationKey(loc)] = actualWaypoints[i].hint
      }
    }
  })
})()
