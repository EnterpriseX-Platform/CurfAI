package com.enterprisex.curf.engine.application.report;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.enterprisex.curf.engine.application.report.ReportDefinitions.Parsed;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.report.ReportParameter;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class ReportDefinitionsTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final ReportDefinitions DEFS = new ReportDefinitions(JSON);
    private static final String VIEW = UUID.randomUUID().toString();

    private static JsonNode def(String json) {
        return JSON.readTree(json);
    }

    /** A Curf definition: one raw query, one governed query, a table and a chart, plus a drill-down target. */
    private static String report(String extraQuery, String extraBlockConfig) {
        return """
                {"version":1,"name":"Sales Summary","category":"Sales",
                 "parameters":[
                   {"name":"from","label":"From","type":"date","default":"2025-06-01","required":true},
                   {"name":"region","label":"Region","type":"select","options":[{"value":"north","label":"North"},{"value":"south","label":"South"}]},
                   {"name":"min","label":"Min","type":"number","default":0}],
                 "dataSources":[
                   {"id":"ds_total","name":"Totals","dataSourceId":"conn-1","sql":"SELECT SUM(revenue) AS revenue FROM sales WHERE sale_date >= :from"},
                   {"id":"ds_by_region","name":"By region","dataSourceId":"%s","engine":{"viewId":"%s",
                      "filters":[{"column":"region","op":"EQ","value":{"$param":"region"},"skipIfEmpty":true}],
                      "groupBy":["region"],"aggregates":[{"fn":"SUM","column":"revenue","as":"revenue"}]}},
                   {"id":"ds_detail","name":"Detail","dataSourceId":"conn-1","sql":"SELECT * FROM sales WHERE region = :region"}%s],
                 "pages":[{"id":"p1","size":"A4","orientation":"portrait","blocks":[
                   {"id":"b1","type":"title","x":0,"y":0,"w":12,"h":2,"config":{"text":"Sales","subtitle":"{{param.from}}"}},
                   {"id":"b2","type":"kpi","x":0,"y":2,"w":4,"h":3,"config":{"queryId":"ds_total","valueField":"revenue"}},
                   {"id":"b3","type":"chart","x":0,"y":5,"w":12,"h":6,"config":{"queryId":"ds_by_region","chartType":"bar","xField":"region","yFields":["revenue"],
                      "drilldown":{"queryId":"ds_detail","filterParam":"region"}%s}}]}]}
                """.formatted(VIEW, VIEW, extraQuery, extraBlockConfig);
    }

    @Test
    void readsParametersQueriesAndWhichQueriesOnlyADrillDownUses() {
        Parsed parsed = DEFS.parse(def(report("", "")));

        assertThat(parsed.name()).isEqualTo("Sales Summary");
        assertThat(parsed.parameters()).extracting(ReportParameter::name).containsExactly("from", "region", "min");
        assertThat(parsed.parameters().get(0)).satisfies(p -> {
            assertThat(p.type()).isEqualTo(ReportParameter.Type.DATE);
            assertThat(p.required()).isTrue();
            assertThat(p.defaultValue()).isEqualTo("2025-06-01");
        });
        assertThat(parsed.parameters().get(1).options()).containsExactly("north", "south");
        assertThat(parsed.queries()).extracting(q -> q.id()).containsExactly("ds_total", "ds_by_region", "ds_detail");
        assertThat(parsed.queries().get(0).engine()).isNull();
        assertThat(parsed.queries().get(1).engine().viewId()).hasToString(VIEW);
        assertThat(parsed.queries().get(1).engine().filters().get(0).skipIfEmpty()).isTrue();
        assertThat(parsed.drillOnly()).containsExactly("ds_detail");
    }

    @Test
    void aQueryAlsoUsedByAPlainBlockIsNotDrillOnly() {
        JsonNode d = def(report("", ""));
        ((tools.jackson.databind.node.ObjectNode) d.get("pages").get(0).get("blocks").get(0).get("config")).put("queryId", "ds_detail");
        assertThat(DEFS.parse(d).drillOnly()).isEmpty();
    }

    @Test
    void anyKeyNamedQueryIdOrEndingInQueryIdCountsAsAReference() {
        JsonNode d = def(report("", ", \"sparkQueryId\":\"ds_total\""));
        assertThat(ReportDefinitions.refs(d.get("pages"))).contains("ds_total", "ds_by_region", "ds_detail");
        ((tools.jackson.databind.node.ObjectNode) d.get("pages").get(0).get("blocks").get(2).get("config")).put("pinsQueryId", "nope");
        assertThatThrownBy(() -> DEFS.parse(d)).isInstanceOf(EngineException.class).hasMessageContaining("not valid");
    }

    @Test
    void refusesWhatTheEngineCannotRun() {
        for (String bad : new String[] {
            ",{\"id\":\"j\",\"name\":\"J\",\"dataSourceId\":\"c\",\"sql\":\"select 1\",\"joins\":[{\"type\":\"left\",\"queryId\":\"ds_total\",\"on\":{\"left\":\"a\",\"right\":\"b\"},\"alias\":\"x\"}]}",
            ",{\"id\":\"r\",\"name\":\"R\",\"dataSourceId\":\"c\",\"method\":\"GET\",\"path\":\"/x\",\"sql\":\"select 1\"}",
            ",{\"id\":\"a\",\"name\":\"A\",\"dataSourceId\":\"c\",\"sql\":\"select 1\",\"attaches\":[{\"dataSourceId\":\"d\",\"alias\":\"d\"}]}",
            ",{\"id\":\"w\",\"name\":\"W\",\"dataSourceId\":\"c\",\"sql\":\"DELETE FROM sales\"}",
            ",{\"id\":\"both\",\"name\":\"B\",\"dataSourceId\":\"c\",\"sql\":\"select 1\",\"engine\":{\"viewId\":\"" + VIEW + "\"}}",
            ",{\"id\":\"neither\",\"name\":\"N\",\"dataSourceId\":\"c\"}",
            ",{\"id\":\"ds_total\",\"name\":\"Dup\",\"dataSourceId\":\"c\",\"sql\":\"select 1\"}",
            ",{\"id\":\"p\",\"name\":\"P\",\"dataSourceId\":\"c\",\"engine\":{\"viewId\":\"" + VIEW + "\",\"filters\":[{\"column\":\"x\",\"op\":\"EQ\",\"value\":{\"$param\":\"undeclared\"}}]}}",
            ",{\"id\":\"nv\",\"name\":\"NV\",\"dataSourceId\":\"c\",\"engine\":{}}",
        }) {
            assertThatThrownBy(() -> DEFS.parse(def(report(bad, "")))).as(bad).isInstanceOf(EngineException.class);
        }
    }

    @Test
    void refusesBrokenDefinitions() {
        for (String bad : new String[] {
            "[]", "{}", "{\"version\":2,\"name\":\"x\",\"pages\":[{\"blocks\":[]}]}", "{\"version\":1,\"name\":\"\",\"pages\":[{\"blocks\":[]}]}",
            "{\"version\":1,\"name\":\"x\",\"pages\":[]}", "{\"version\":1,\"name\":\"x\"}",
            "{\"version\":1,\"name\":\"x\",\"pages\":[{\"blocks\":[{\"config\":{\"queryId\":\"missing\"}}]}]}",
            "{\"version\":1,\"name\":\"x\",\"parameters\":[{\"name\":\"__x\",\"type\":\"string\"}],\"pages\":[{\"blocks\":[]}]}",
            "{\"version\":1,\"name\":\"x\",\"parameters\":[{\"name\":\"a\",\"type\":\"string\"},{\"name\":\"a\",\"type\":\"string\"}],\"pages\":[{\"blocks\":[]}]}",
            "{\"version\":1,\"name\":\"x\",\"parameters\":[{\"name\":\"a b\",\"type\":\"string\"}],\"pages\":[{\"blocks\":[]}]}",
            "{\"version\":1,\"name\":\"x\",\"parameters\":[{\"name\":\"a\",\"type\":\"colour\"}],\"pages\":[{\"blocks\":[]}]}",
        }) {
            assertThatThrownBy(() -> DEFS.parse(def(bad))).as(bad).isInstanceOf(EngineException.class);
        }
        assertThatThrownBy(() -> DEFS.parse(null)).isInstanceOf(EngineException.class);
    }

    @Test
    void aMinimalReportWithNoQueriesIsFine() {
        Parsed parsed = DEFS.parse(def("{\"version\":1,\"name\":\"Plain text\",\"pages\":[{\"id\":\"p\",\"blocks\":[{\"type\":\"text\",\"config\":{\"text\":\"hi\"}}]}]}"));
        assertThat(parsed.queries()).isEmpty();
        assertThat(parsed.parameters()).isEmpty();
    }
}
