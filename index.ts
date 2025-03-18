import express, { Express, Request, Response } from 'express'
import axios from 'axios'
import { FORMAT_HTTP_HEADERS, Tags } from "opentracing"
import pino from "pino"
import pinohttp from "pino-http"
import Jaeger from "jaeger-client"
import prometheus from "prom-client"

interface CustomResponse {
  location: string
  data?: any
  error?: string
}

// ------- ExpressJS --------------
const app: Express = express()
app.use(pinohttp())
app.use(express.json())
app.listen(3000, () => console.log('App listening on port 3000'))
// ------- ExpressJS --------------

//? ------- Jaeger --------------
const tracer = () => {
  const options = { logger: pino() }
  const config = {
    serviceName: `servicemesh-node-${process.env.ID}`,
    sampler: {
      type: "const",
      param: 1,
    },
    reporter: {
      logSpans: true,
      collectorEndpoint: process.env.JAEGER_COLLECTOR_ENDPOINT
    }
  }
  const tracer = Jaeger.initTracer(config, options)
  const codec = new Jaeger.ZipkinB3TextMapCodec({ urlEncoding: true })
  tracer.registerInjector(FORMAT_HTTP_HEADERS, codec)
  tracer.registerExtractor(FORMAT_HTTP_HEADERS, codec)
  return tracer
}
const globalTracer = tracer()
//? ------- Jaeger --------------

//! ------- Prometheus --------------
const register = new prometheus.Registry()
register.setDefaultLabels({
  app: `servicemesh_node_${process.env.ID}`
})
const responseTime = new prometheus.Gauge({
    name: `servicemesh_node_${process.env.ID}:ch_response_time`,
    help: 'Time take in seconds to response'
})
const views = new prometheus.Counter({
  name: `servicemesh_node_${process.env.ID}:ch_view_count`,
  help: 'No of page views'
})
register.registerMetric(responseTime)
register.registerMetric(views)
//! ------- Prometheus --------------



//* ------- Variables | Messages --------------
const jumps: number = parseInt(process.env.JUMPS || "6")
const curtime = () => `${new Date().getMinutes()}:${new Date().getSeconds()}`
const message = (data: any): CustomResponse => ({
  location: `\nThis is ${process.env.ID} @${curtime()}`,
  data
})
const errmsg = (err: any): CustomResponse => ({
  location: `\nThis is ${process.env.ID} @${curtime()}`,
  error: err || `\n${process.env.ID} @${curtime()} -> unavailable`
})
//* ------- Variables | Messages --------------

//! -------------- Client --------------
const chain = async (endpoint: string,  request: Request): Promise<CustomResponse> => {
  const parentSpan = globalTracer.extract(FORMAT_HTTP_HEADERS, request.headers)
  let span: Jaeger.opentracing.Span | null = null
  const spanname= `servicemesh-node-${process.env.ID}:chain`
  if (parentSpan) 
    span = globalTracer.startSpan(spanname, { childOf: parentSpan })
  else 
    span = globalTracer.startSpan(spanname)
  try {
    span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_SERVER)
    span.setTag(Tags.HTTP_METHOD, request.method)
    span.setTag(Tags.HTTP_URL, request.originalUrl)

    globalTracer.inject(span, FORMAT_HTTP_HEADERS, request.headers)
    
    const response = await axios.get(endpoint, { headers: request.headers })
    return message(response.data)
  } catch (err: any) {
    return errmsg(err.response.data)
  } finally {
    span.finish()
  }
}
//! -------------- Client --------------

// -------------- Endpoint --------------
app.get('/chain', async (req: Request, res: Response) => {
  const count = (parseInt(`${req.query['count']}`) || 0) + 1
  const endpoint = `${process.env.CHAIN_SVC}?count=${count}`
  responseTime.setToCurrentTime()
  const end = responseTime.startTimer();
  views.inc()
  if (count >= jumps) {
    return res.status(200).send(message('\nLast'))
  }
  try {
    const response = await chain(endpoint, req)
    end()
    res.status(200).send(response)
  } catch (error) {
    res.status(200).send(error)
  }
})
app.get('/metrics', async (req: Request, res: Response) => {
  res.set('Content-Type', register.contentType)
  res.status(200).send(await register.metrics())
})
// -------------- Endpoint --------------
