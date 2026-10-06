package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.query.QueryRequest;
import com.enterprisex.curf.engine.application.query.QueryResult;
import com.enterprisex.curf.engine.application.query.QueryService;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/queries")
public class QueryController {

    private final QueryService service;

    public QueryController(QueryService service) {
        this.service = service;
    }

    @PostMapping("/execute")
    QueryResult execute(Viewer viewer, @RequestBody QueryRequest request) {
        return service.execute(viewer, request);
    }
}
